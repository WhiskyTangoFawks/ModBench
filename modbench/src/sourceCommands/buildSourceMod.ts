// mods.md, Build: the extension writes what a source mod's build file takes from its packages, mEdit compiles and packs what
// it is handed, and the extension records in the mod's manifest what the build made (ADR-0016).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildOutcome, type MadeFile, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter, ModMetadata } from '../instanceAdapter/instanceAdapter';
import {
  folderAgainst, lineAtFolderPath, manifestIn, packageOf, unmarked, writeManifestIn, type BuildFile, type Manifest, type ManifestFile, type ManifestPackage,
} from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { ba2VersionsOf } from '../tables/gamePaths';
import { toolsWithoutTask, type PackagesRead } from './packagesRead';
import type { StepTasks } from './steps';

type Adapter = Pick<InstanceAdapter, 'exclusionMark' | 'writeFilesIn' | 'filesIn' | 'originFileHash' | 'folderValue' | 'trashFileIn'>;

type FolderValue = Awaited<ReturnType<Adapter['folderValue']>>;

export interface BuildDeps {
  readonly client: Pick<MEditClient, 'build'>;
  readonly adapter: Adapter;
  readonly tasks: StepTasks;
  readonly trash: MoveToTrash;
}

/** A source mod to build: its folder and the paths the modlist excludes from it, the repository that builds it and the
 *  build file it holds, where this machine holds its packages, and the metadata and host its manifest records. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly exclude: readonly string[];
  readonly sourceFolder: string;
  readonly buildFile: BuildFile;
  readonly packages: PackagesRead;
  readonly metadata: ModMetadata;
  readonly isSubmodule: boolean;
}

/** What every mod's build is handed: mEdit's facts, and the label of each VS Code task this machine has. */
export interface BuildPass {
  readonly facts: BuildFacts;
  readonly tasks: ReadonlySet<string>;
}

/** A mod that built, as mEdit answers it without the files it made. `trashed`: each other file its folder held; of
 *  those, `undeclared`: each its steps made, or one's marked copy, that its build file does not name. */
export type ModBuilt = Omit<BuildOutcome['landed'][number], 'made'> & { readonly trashed?: readonly string[]; readonly undeclared?: readonly string[] };

/** A mod refused before anything was written; `lacksATask`: this machine has no task for a tool its steps run. */
export type BuildRefusal = ItemRefusal<string> & { readonly lacksATask?: true };

export interface SourceBuildOutcome {
  readonly landed: readonly ModBuilt[];
  readonly refused: readonly BuildRefusal[];
}

/** The release's archive variants, none when the table names none. Modbench packs a BA2 compressed, as the game's own are. */
export function archiveVariants(gameRelease: string): BuildFacts['archives'] {
  const versions = ba2VersionsOf(gameRelease);
  return versions === undefined
    ? null
    : { general: { ba2: { version: versions.general, compressed: true } }, textures: { ba2: { version: versions.textures, compressed: true } } };
}

const notBuilt = (why: string): string => `was not built: ${why.replace(/\.$/, '')}.`;

/** A source mod's manifest: its repository, each package its build file names, and its metadata as update manifest
 *  records it (commands.md, build). */
export function sourceModManifest(
  buildFile: Pick<BuildFile, 'packages'>, repository: ManifestPackage, metadata: ModMetadata, files: readonly ManifestFile[],
): Manifest {
  const installedFrom = buildFile.packages.find(({ kind, name }) => kind === 'installationFile' && name === metadata.installationFile?.name);
  return {
    packages: [repository, ...buildFile.packages], exclude: [], archives: [], files,
    ...metadata.version === undefined ? {} : { version: metadata.version },
    ...installedFrom === undefined ? {} : { installationFile: installedFrom.name },
  };
}

const repositoryPackage = (mod: SourceModToBuild): ManifestPackage => ({ kind: 'sourceRepository', name: basename(mod.sourceFolder), isSubmodule: mod.isSubmodule });

// mods.md, Build, story 1: each file the build file takes from a package, written where the folder holds it unless it holds
// those bytes, before mEdit packs it or compiles beside it.
async function takenWritten(adapter: Adapter, mod: SourceModToBuild): Promise<{ lines: ManifestFile[]; wrote: boolean }> {
  const { buildFile, packages, folder, exclude } = mod;
  const lines: ManifestFile[] = [];
  const writes: Parameters<Adapter['writeFilesIn']>[1][number][] = [];
  for (const line of buildFile.files) {
    const from = packages.packageFiles.get(line.path);
    const hash = packages.hashes.get(line.path);
    if (from === undefined || hash === undefined) continue;
    const { path, entry } = lineAtFolderPath({ ...buildFile, exclude }, line, adapter.exclusionMark);
    lines.push({ path, entry, package: packageOf(buildFile, line)?.name, hash });
    const there = await adapter.originFileHash(join(folder, path));
    if (there.kind === 'read' && there.answer.hash === hash) continue;
    writes.push({ path, from });
  }
  if (writes.length > 0) await adapter.writeFilesIn(folder, writes);
  return { lines, wrote: writes.length > 0 };
}

// A line that names the package it comes from, which another first package leaves it still naming.
const namingItsPackage = (manifest: Manifest, line: ManifestFile): ManifestFile => {
  const named = line.entry.kind === 'madeByStep' || line.package !== undefined ? undefined : packageOf(manifest, line)?.name;
  return named === undefined ? line : { ...line, package: named };
};

// mods.md, Build, story 10: the manifest records each taken file once it is written, so a build that stops after leaves
// none to read as changed outside Modbench. Every other line, and each package one names, stays.
async function takenRecorded(mod: SourceModToBuild, taken: readonly ManifestFile[]): Promise<void> {
  const read = await manifestIn(mod.folder);
  const previous = read !== undefined && 'manifest' in read ? read.manifest : undefined;
  const at = new Set(taken.map(({ path }) => path));
  const kept = previous === undefined ? [] : previous.files.filter(({ path }) => !at.has(path)).map((line) => namingItsPackage(previous, line));
  const record = sourceModManifest(mod.buildFile, repositoryPackage(mod), mod.metadata, [...kept, ...taken]);
  const named = new Set(record.packages.map(({ name }) => name));
  const stillNamed = (previous?.packages ?? []).filter(({ name }) => !named.has(name) && kept.some((line) => line.package === name));
  await writeManifestIn(mod.folder, { ...record, packages: [...record.packages, ...stillNamed] });
}

/** Why one of `paths` in `folder` could not be moved to the trash, or a folder that left empty removed, if one could not. */
export async function whyNotTrashed(adapter: Pick<InstanceAdapter, 'trashFileIn'>, trash: MoveToTrash, folder: string, paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const emptied = await adapter.trashFileIn(folder, path, trash);
      if (emptied !== undefined) return emptied;
    } catch (err) {
      return `'${path}' could not be moved to the trash: ${errorMessage(err)}`;
    }
  }
  return undefined;
}

interface Output {
  readonly vouched: ReadonlySet<string>;
  readonly taken: ReadonlyMap<string, ManifestFile>;
  readonly stepped: ReadonlySet<string>;
  readonly leftAsItWas: readonly string[];
}

function outputOf({ buildFile }: SourceModToBuild, made: readonly MadeFile[], taken: readonly ManifestFile[]): Output {
  const stepped = new Set(buildFile.files.filter(({ entry }) => entry.kind === 'madeByStep').map(({ path }) => path));
  const vouched = new Set([...made.filter(({ vouchedFor }) => vouchedFor).map(({ path }) => path), ...taken.map(({ path }) => path)].filter((path) => !stepped.has(path)));
  return { vouched, taken: new Map(taken.map((line) => [line.path, line])), stepped, leftAsItWas: made.filter(({ vouchedFor }) => !vouchedFor).map(({ path }) => path) };
}

// The output as lines that record no bytes, so the folder is read against it by status's own rule, its case included.
const outputAgainst = (repository: ManifestPackage, output: Output, folder: FolderValue): ReturnType<typeof folderAgainst> => {
  const lines = [...output.vouched, ...output.stepped, ...output.leftAsItWas].map((path): ManifestFile => ({ path, entry: { kind: 'held' } }));
  return folderAgainst({ packages: [repository], exclude: [], archives: [], files: lines }, folder, new Map());
};

// mods.md, Build, stories 3 and 8: a file mEdit left as it was keeps its last recorded line while the folder holds those
// bytes; otherwise it has no line. A file no package gives comes from the repository.
function linesOf(output: Output, repository: string, onDisk: ReadonlyMap<string, string>, folder: FolderValue, previous: readonly ManifestFile[]): ManifestFile[] {
  const kept = output.leftAsItWas.filter((path) => !output.stepped.has(path)).flatMap((path): ManifestFile[] => {
    const line = previous.find((recorded) => recorded.path === path);
    const at = onDisk.get(path);
    const read = at === undefined ? undefined : folder.files.get(at);
    return line?.hash !== undefined && read?.kind === 'read' && read.answer.hash === line.hash ? [{ ...line, package: repository }] : [];
  });
  return [...kept, ...[...output.vouched, ...output.stepped].flatMap((path): ManifestFile[] => {
    const at = onDisk.get(path);
    if (at === undefined) return [];
    const line = output.taken.get(path) ?? { path, entry: { kind: 'held' }, package: repository };
    if (output.stepped.has(path)) return [line];
    const read = folder.files.get(at);
    if (read?.kind !== 'read') throw new Error(`'${path}' could not be read${read === undefined ? '' : `: ${read.reason}`}`);
    return [{ ...line, hash: read.answer.hash }];
  })];
}

// mods.md, A source mod, story 4, and Build, story 3: every other file goes to the trash, then the manifest names the
// packages and each file the build made. `beforeSteps`: the folder's files before its steps ran.
async function recorded(
  { adapter, trash }: BuildDeps, mod: SourceModToBuild, output: Output, beforeSteps: ReadonlySet<string> | undefined,
): Promise<Pick<ModBuilt, 'failure' | 'trashed' | 'undeclared'>> {
  const repository = repositoryPackage(mod);
  try {
    const folder = await adapter.folderValue(mod.folder);
    const read = await manifestIn(mod.folder);
    const previous = read !== undefined && 'manifest' in read ? read.manifest.files : [];
    const against = outputAgainst(repository, output, folder);
    const trashed = against.namedByNoLine;
    const why = await whyNotTrashed(adapter, trash, mod.folder, trashed);
    if (why !== undefined) return { failure: `The build stopped as ${why}, so its manifest was not written.` };
    const onDisk = new Map(against.lines.flatMap(({ line, onDisk: at }) => (at === undefined ? [] : [[line.path, at] as const])));
    await writeManifestIn(mod.folder, sourceModManifest(mod.buildFile, repository, mod.metadata, linesOf(output, repository.name, onDisk, folder, previous)));
    const undeclared = trashed.filter((path) => (beforeSteps !== undefined && !beforeSteps.has(path)) || output.stepped.has(unmarked(path, adapter.exclusionMark)));
    return { ...trashed.length === 0 ? {} : { trashed }, ...undeclared.length === 0 ? {} : { undeclared } };
  } catch (err) {
    return { failure: `The build could not write its manifest: ${errorMessage(err)}` };
  }
}

type Built = { readonly landed: ModBuilt } | { readonly refusal: BuildRefusal } | WriteRefused;

const refusedAs = (mod: string, why: string, lacksATask = false): { readonly refusal: BuildRefusal } =>
  ({ refusal: { item: mod, reason: notBuilt(why), ...lacksATask ? { lacksATask: true } : {} } });

// mods.md, Build, story 13: what refuses the mod is checked before its first write.
function refusedBeforeWriting({ name, buildFile, packages }: SourceModToBuild, pass: BuildPass): { readonly refusal: BuildRefusal } | undefined {
  const noTask = toolsWithoutTask(buildFile, pass.tasks);
  if (noTask !== undefined) return refusedAs(name, noTask, true);
  return packages.lacks.length > 0 ? refusedAs(name, packages.lacks.join('; ')) : undefined;
}

// mods.md, Build, stories 1 and 3: the steps run once mEdit made the folder, and the manifest is written last.
async function finished(
  deps: BuildDeps, mod: SourceModToBuild, landed: ModBuilt, made: readonly MadeFile[], taken: readonly ManifestFile[],
): Promise<ModBuilt> {
  if (landed.failure !== undefined) return landed;
  const { steps } = mod.buildFile;
  if (steps.length === 0) return { ...landed, ...await recorded(deps, mod, outputOf(mod, made, taken), undefined) };
  let beforeSteps: ReadonlySet<string>;
  try {
    beforeSteps = new Set(await deps.adapter.filesIn(mod.folder));
  } catch (err) {
    return { ...landed, failure: `The build stopped before its steps, as its folder could not be read: ${errorMessage(err)}` };
  }
  const stepFailed = await deps.tasks.whyStepsFailed(steps, mod.folder);
  if (stepFailed !== undefined) return { ...landed, failure: `The build stopped as its ${stepFailed}, so its manifest was not written.` };
  return { ...landed, ...await recorded(deps, mod, outputOf(mod, made, taken), beforeSteps) };
}

/** The mod built, refused before anything was written, or mEdit's refusal of the whole call. */
export async function buildSourceMod(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built> {
  const { name, folder, buildFile, exclude } = mod;
  const refusal = refusedBeforeWriting(mod, pass);
  if (refusal !== undefined) return refusal;
  const stopped = (failure: string): Built => ({ landed: { mod: name, compiled: [], refused: [], archivesRefused: [], failure: `The build stopped before compiling, as ${failure}` } });
  let written: Awaited<ReturnType<typeof takenWritten>>;
  try {
    written = await takenWritten(deps.adapter, mod);
  } catch (err) {
    return stopped(`a file its packages give could not be written: ${errorMessage(err)}`);
  }
  const taken = written.lines;
  try {
    if (written.wrote) await takenRecorded(mod, taken);
  } catch (err) {
    return stopped(`its manifest could not record the files its packages give: ${errorMessage(err)}`);
  }
  const answer = await deps.client.build([{
    name, sourceFolder: mod.sourceFolder, folder, exclude: [...exclude], taken: taken.map(({ path }) => path),
    archives: buildFile.archives.map(({ path, files }) => ({ path, files: [...files] })),
  }], pass.facts);
  if (isRefused(answer)) return answer;
  const [mEditRefused] = answer.refused;
  if (mEditRefused !== undefined) return { refusal: mEditRefused };
  const [built] = answer.landed;
  if (built === undefined) return refusedAs(name, 'mEdit answered nothing for it');
  const { made, ...outcome } = built;
  return { landed: await finished(deps, mod, outcome, made, taken) };
}
