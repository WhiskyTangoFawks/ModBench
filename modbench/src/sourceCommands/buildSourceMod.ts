// mods.md, Build: the extension writes what a source mod's build file takes from its packages, mEdit compiles and packs what
// it is handed, and the extension records in the mod's manifest what the build made (ADR-0016).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildOutcome, type MadeFile, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { folderAgainst, manifestIn, writeManifestIn, type BuildFile, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { ba2VersionsOf } from '../tables/gamePaths';
import { toolsWithoutTask, type PackagesRead } from './packagesRead';
import type { StepTasks } from './steps';

type Adapter = Pick<InstanceAdapter, 'pathInFolder' | 'writeFilesIn' | 'filesIn' | 'originFileHash' | 'folderValue' | 'trashFileIn' | 'trashingReplaced'>;

type FolderValue = Awaited<ReturnType<InstanceAdapter['folderValue']>>;

export interface BuildDeps {
  readonly client: Pick<MEditClient, 'build'>;
  readonly adapter: Adapter;
  readonly tasks: StepTasks;
  readonly trash: MoveToTrash;
}

/** A source mod to build: its folder and the paths the modlist excludes from it, the repository that builds it and the
 *  build file it holds, and where this machine holds its packages. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly exclude: readonly string[];
  readonly sourceFolder: string;
  readonly buildFile: BuildFile;
  readonly packages: PackagesRead;
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

// A file the build takes from a package: its own path, where the folder holds it, and its hash.
interface TakenFile {
  readonly path: string;
  readonly pathInFolder: string;
  readonly hash: string;
}

interface Taken {
  readonly files: readonly TakenFile[];
  readonly writes: readonly Parameters<Adapter['writeFilesIn']>[1][number][];
}

// mods.md, Build, story 1: each file the build file takes from a package, written where the folder holds it unless it holds
// those bytes, before mEdit packs it or compiles beside it.
async function takenOf(adapter: Adapter, mod: SourceModToBuild): Promise<Taken> {
  const files: TakenFile[] = [];
  const writes: Taken['writes'][number][] = [];
  for (const line of mod.buildFile.files) {
    const from = mod.packages.packageFiles.get(line.path);
    const hash = mod.packages.hashes.get(line.path);
    if (from === undefined || hash === undefined) continue;
    const pathInFolder = adapter.pathInFolder(line.path, mod.exclude);
    files.push({ path: line.path, pathInFolder, hash });
    const there = await adapter.originFileHash(join(mod.folder, pathInFolder));
    if (there.kind === 'read' && there.answer.hash === hash) continue;
    writes.push({ path: pathInFolder, from });
  }
  return { files, writes };
}

const heldManifest = async (folder: string): Promise<Manifest | undefined> => {
  const read = await manifestIn(folder);
  return read !== undefined && 'manifest' in read ? read.manifest : undefined;
};

// A manifest names only the exclusions of the files it names (formats/manifest.md).
function sourceModManifest(mod: SourceModToBuild, files: ReadonlyMap<string, string | null>): Manifest {
  const paths = [...files.keys()].map((path) => path.toLowerCase());
  const exclude = mod.exclude.filter((excluded) => paths.some((path) => path === excluded.toLowerCase() || path.startsWith(`${excluded.toLowerCase()}/`)));
  return { packages: [{ kind: 'repository', name: basename(mod.sourceFolder) }], exclude, files };
}

// mods.md, A source mod, story 4: each file whose bytes its manifest does not record, which no build can make again.
async function unrecordedIn(adapter: Adapter, mod: SourceModToBuild): Promise<string[]> {
  const files = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
  const against = folderAgainst({ files, exclude: mod.exclude }, await adapter.folderValue(mod.folder));
  return [...against.files.flatMap(({ pathInFolder, holdsItsBytes }) => (holdsItsBytes === false && pathInFolder !== undefined ? [pathInFolder] : [])), ...against.namedByNoLine];
}

// mods.md, Build, story 10: what a build wrote is recorded once it is written, so a build that stops after leaves none to
// read as changed outside Modbench. Every other file stays.
async function writtenRecorded(mod: SourceModToBuild, written: ReadonlyMap<string, string | null>): Promise<void> {
  const previous = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
  await writeManifestIn(mod.folder, sourceModManifest(mod, new Map([...previous, ...written])));
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

// What the build made, each file by the path the folder holds it at.
interface Output {
  readonly vouched: ReadonlySet<string>;
  readonly stepped: ReadonlySet<string>;
  readonly leftAsItWas: readonly string[];
}

function outputOf(mod: SourceModToBuild, made: readonly MadeFile[], taken: readonly TakenFile[]): Output {
  const stepped = new Set(mod.buildFile.files.filter(({ entry }) => entry.kind === 'madeByStep').map(({ path }) => path));
  const vouched = new Set([...made.filter(({ vouchedFor }) => vouchedFor).map(({ path }) => path), ...taken.map(({ pathInFolder }) => pathInFolder)].filter((path) => !stepped.has(path)));
  return { vouched, stepped, leftAsItWas: made.filter(({ vouchedFor }) => !vouchedFor).map(({ path }) => path) };
}

// Each file of the folder by the path it holds it at, matched in any case where the file system ignores it.
function heldAt(folder: FolderValue): (pathInFolder: string) => { readonly path: string; readonly hash?: string; readonly unreadable?: string } | undefined {
  const byFolded = new Map([...folder.files].map(([pathInFolder, file]) => [pathInFolder.toLowerCase(), file]));
  return (pathInFolder) => {
    const held = folder.files.get(pathInFolder) ?? (folder.ignoresCase ? byFolded.get(pathInFolder.toLowerCase()) : undefined);
    if (held === undefined) return undefined;
    const { read } = held;
    return read.kind === 'read' ? { path: held.path, hash: read.answer.hash } : { path: held.path, unreadable: read.reason };
  };
}

// mods.md, Build, stories 3 and 8: a file mEdit left as it was keeps its last recorded hash while the folder holds those
// bytes, and a file a step makes is named without its bytes.
function filesOf(output: Output, folder: FolderValue, previous: ReadonlyMap<string, string | null>): Map<string, string | null> {
  const at = heldAt(folder);
  const files = new Map<string, string | null>();
  for (const pathInFolder of output.leftAsItWas.filter((path) => !output.stepped.has(path))) {
    const held = at(pathInFolder);
    const recorded = held === undefined ? undefined : previous.get(held.path);
    if (held !== undefined && recorded !== undefined && recorded !== null && held.hash === recorded) files.set(held.path, recorded);
  }
  for (const pathInFolder of output.stepped) {
    const held = at(pathInFolder);
    if (held !== undefined) files.set(held.path, null);
  }
  for (const pathInFolder of output.vouched) {
    const held = at(pathInFolder);
    if (held === undefined) continue;
    if (held.hash === undefined) throw new Error(`'${pathInFolder}' could not be read: ${held.unreadable ?? ''}`);
    files.set(held.path, held.hash);
  }
  return files;
}

const notInOutput = (output: Output, folder: FolderValue): string[] => {
  const exact = new Set([...output.vouched, ...output.stepped, ...output.leftAsItWas]);
  const named = new Set([...exact].map((path) => path.toLowerCase()));
  return [...folder.files.keys()]
    .filter((path) => !exact.has(path) && !(folder.ignoresCase && named.has(path.toLowerCase()))).sort();
};

// mods.md, Build, story 10: a build that stops records each file mEdit vouches for and each taken file, which are written.
async function stoppedAs({ adapter }: BuildDeps, mod: SourceModToBuild, output: Output, failure: string): Promise<string> {
  try {
    const folder = await adapter.folderValue(mod.folder);
    await writtenRecorded(mod, filesOf({ ...output, stepped: new Set(), leftAsItWas: [] }, folder, new Map()));
    return failure;
  } catch (err) {
    return `${failure} Its manifest could not record what it wrote: ${errorMessage(err)}`;
  }
}

// mods.md, A source mod, story 4, and Build, story 3: every other file goes to the trash, then the manifest names the
// repository and each file the build made. `beforeSteps`: the folder's files before its steps ran.
async function recorded(
  deps: BuildDeps, mod: SourceModToBuild, output: Output, beforeSteps: ReadonlySet<string> | undefined,
): Promise<Pick<ModBuilt, 'failure' | 'trashed' | 'undeclared'>> {
  const { adapter, trash } = deps;
  try {
    const folder = await adapter.folderValue(mod.folder);
    const previous = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
    const trashed = notInOutput(output, folder);
    const why = await whyNotTrashed(adapter, trash, mod.folder, trashed);
    if (why !== undefined) return { failure: await stoppedAs(deps, mod, output, `The build stopped as ${why}.`) };
    await writeManifestIn(mod.folder, sourceModManifest(mod, filesOf(output, folder, previous)));
    const stepped = new Set(mod.buildFile.files.filter(({ entry }) => entry.kind === 'madeByStep').map(({ path }) => path.toLowerCase()));
    const undeclared = trashed.filter((path) => (beforeSteps !== undefined && !beforeSteps.has(path)) || stepped.has((folder.files.get(path)?.path ?? path).toLowerCase()));
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

// What mEdit and the steps made, before the manifest records it; `failure`: why the build stopped.
interface Ran {
  readonly outcome: ModBuilt;
  readonly output: Output;
  readonly failure?: string;
  readonly beforeSteps?: ReadonlySet<string>;
}

// mods.md, Build, story 1: the steps run once mEdit made the folder.
async function builtAndStepped(deps: BuildDeps, mod: SourceModToBuild, taken: readonly TakenFile[], pass: BuildPass): Promise<Built | Ran> {
  const answer = await deps.client.build([{
    name: mod.name, sourceFolder: mod.sourceFolder, folder: mod.folder, exclude: [...mod.exclude], taken: taken.map(({ pathInFolder }) => pathInFolder),
    archives: mod.buildFile.archives.map(({ path, files }) => ({ path, files: [...files] })),
  }], pass.facts);
  if (isRefused(answer)) return answer;
  const [mEditRefused] = answer.refused;
  if (mEditRefused !== undefined) return { refusal: mEditRefused };
  const [built] = answer.landed;
  if (built === undefined) return refusedAs(mod.name, 'mEdit answered nothing for it');
  const { made, ...outcome } = built;
  const output = outputOf(mod, made, taken);
  const { steps } = mod.buildFile;
  if (outcome.failure !== undefined || steps.length === 0) return { outcome, output, failure: outcome.failure };
  let beforeSteps: ReadonlySet<string>;
  try {
    beforeSteps = new Set(await deps.adapter.filesIn(mod.folder));
  } catch (err) {
    return { landed: { ...outcome, failure: `The build stopped before its steps, as its folder could not be read: ${errorMessage(err)}` } };
  }
  const stepFailed = await deps.tasks.whyStepsFailed(steps, mod.folder);
  return { outcome, output, beforeSteps, failure: stepFailed === undefined ? undefined : `The build stopped as its ${stepFailed}.` };
}

// The taken files written, trashing each they replace, then mEdit and the steps.
async function written(deps: BuildDeps, mod: SourceModToBuild, { files, writes }: Taken, pass: BuildPass): Promise<Built | Ran> {
  const stopped = (failure: string): Built => ({ landed: { mod: mod.name, compiled: [], refused: [], archivesRefused: [], failure: `The build stopped before compiling, as ${failure}` } });
  if (writes.length > 0) {
    try {
      await deps.adapter.writeFilesIn(mod.folder, writes, deps.trash);
    } catch (err) {
      return stopped(`a file its packages give could not be written: ${errorMessage(err)}`);
    }
    try {
      await writtenRecorded(mod, new Map(files.map(({ path, hash }) => [path, hash])));
    } catch (err) {
      return stopped(`its manifest could not record the files its packages give: ${errorMessage(err)}`);
    }
  }
  return builtAndStepped(deps, mod, files, pass);
}

/** The mod built, refused before anything was written, or mEdit's refusal of the whole call. */
export async function buildSourceMod(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built> {
  const refusal = refusedBeforeWriting(mod, pass);
  if (refusal !== undefined) return refusal;
  let taken: Taken;
  let unrecorded: string[];
  try {
    taken = await takenOf(deps.adapter, mod);
    const writing = new Set(taken.writes.map(({ path }) => path.toLowerCase()));
    unrecorded = (await unrecordedIn(deps.adapter, mod)).filter((path) => !writing.has(path.toLowerCase()));
  } catch (err) {
    return refusedAs(mod.name, `its folder could not be read: ${errorMessage(err)}`);
  }
  // mods.md, A source mod, story 4: what no manifest records goes to the trash before anything is written.
  const ran = await deps.adapter.trashingReplaced(mod.folder, unrecorded, deps.trash, () => written(deps, mod, taken, pass));
  if ('notTrashed' in ran) return refusedAs(mod.name, ran.notTrashed);
  const { answer } = ran;
  if (!('output' in answer)) return answer;
  if (answer.failure !== undefined) return { landed: { ...answer.outcome, failure: await stoppedAs(deps, mod, answer.output, answer.failure) } };
  return { landed: { ...answer.outcome, ...await recorded(deps, mod, answer.output, answer.beforeSteps) } };
}
