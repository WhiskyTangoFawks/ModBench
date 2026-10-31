// mods.md, Build: the extension writes what a source mod's build file takes from its packages, mEdit compiles and packs what
// it is handed, and the extension records in the mod's manifest what the build made (ADR-0016).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildOutcome, type MadeFile, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { lineAtFolderPath, writeManifestIn, type BuildFile, type ManifestFile } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { ba2VersionsOf } from '../tables/gamePaths';
import { toolsWithoutTask, type PackagesRead } from './packagesRead';
import type { StepTasks } from './steps';

type Adapter = Pick<InstanceAdapter, 'exclusionMark' | 'writeFilesIn' | 'filesIn' | 'originFileHash' | 'trashFileIn'>;

export interface BuildDeps {
  readonly client: Pick<MEditClient, 'build'>;
  readonly adapter: Adapter;
  readonly tasks: StepTasks;
  readonly trash: MoveToTrash;
}

/** A source mod to build: its folder and the paths the modlist excludes from it, the repository that builds it and the
 *  build file it holds, where this machine holds its packages, and the version and host its manifest records. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly exclude: readonly string[];
  readonly sourceFolder: string;
  readonly buildFile: BuildFile;
  readonly packages: PackagesRead;
  readonly version: string | undefined;
  readonly isSubmodule: boolean;
}

/** What every mod's build is handed: mEdit's facts, and the label of each VS Code task this machine has. */
export interface BuildPass {
  readonly facts: BuildFacts;
  readonly tasks: ReadonlySet<string>;
}

/** A mod that built, as mEdit answers it without the files it made; `trashed`: each other file its folder held. */
export type ModBuilt = Omit<BuildOutcome['landed'][number], 'made'> & { readonly trashed?: readonly string[] };

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

interface Taken {
  readonly at: readonly string[];
  readonly overwritten: readonly string[];
}

// mods.md, Build, story 1: each file the build file takes from a package, written where the folder holds it unless it holds
// those bytes, before mEdit packs it or compiles beside it.
async function takenWritten(adapter: Adapter, mod: SourceModToBuild): Promise<Taken> {
  const { buildFile, packages, folder, exclude } = mod;
  const packed = new Set(buildFile.archives.flatMap(({ files }) => files).map((path) => path.toLowerCase()));
  const at: string[] = [];
  const overwritten: string[] = [];
  const writes: Parameters<Adapter['writeFilesIn']>[1][number][] = [];
  for (const line of buildFile.files) {
    const from = packages.packageFiles.get(line.path);
    if (from === undefined) continue;
    const path = lineAtFolderPath({ ...buildFile, exclude }, line, adapter.exclusionMark).path;
    at.push(path);
    const there = await adapter.originFileHash(join(folder, path));
    if (there.kind === 'read' && there.answer.hash === packages.hashes.get(line.path)) continue;
    if (there.kind === 'read' && !packed.has(line.path.toLowerCase())) overwritten.push(path);
    writes.push({ path, from });
  }
  if (writes.length > 0) await adapter.writeFilesIn(folder, writes);
  return { at, overwritten };
}

/** Why one of `paths` in `folder` could not be moved to the trash, if one could not. */
export async function whyNotTrashed(adapter: Pick<InstanceAdapter, 'trashFileIn'>, trash: MoveToTrash, folder: string, paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await adapter.trashFileIn(folder, path, trash);
    } catch (err) {
      return `'${path}' could not be moved to the trash: ${errorMessage(err)}`;
    }
  }
  return undefined;
}

// The files a build made: those it vouches for, those a step makes, and each mEdit left as it was.
interface Output {
  readonly vouched: ReadonlySet<string>;
  readonly stepped: ReadonlySet<string>;
  readonly leftAsItWas: readonly string[];
}

function outputOf({ buildFile }: SourceModToBuild, made: readonly MadeFile[], taken: readonly string[]): Output {
  const stepped = new Set(buildFile.files.filter(({ entry }) => entry.kind === 'madeByStep').map(({ path }) => path));
  const vouched = new Set([...made.filter(({ vouchedFor }) => vouchedFor).map(({ path }) => path), ...taken].filter((path) => !stepped.has(path)));
  return { vouched, stepped, leftAsItWas: made.filter(({ vouchedFor }) => !vouchedFor).map(({ path }) => path) };
}

// mods.md, Build, story 3: each file the build vouches for by its bytes, and each a step makes by its path alone. A file
// mEdit left as it was has no line.
async function linesOf(adapter: Adapter, mod: SourceModToBuild, output: Output, held: ReadonlySet<string>): Promise<ManifestFile[]> {
  const lines: ManifestFile[] = [];
  for (const path of [...output.vouched, ...output.stepped].filter((one) => held.has(one))) {
    if (output.stepped.has(path)) {
      lines.push({ path, entry: { kind: 'held' } });
      continue;
    }
    const read = await adapter.originFileHash(join(mod.folder, path));
    if (read.kind === 'unreadable') throw new Error(`'${path}' could not be read: ${read.reason}`);
    lines.push({ path, entry: { kind: 'held' }, hash: read.answer.hash });
  }
  return lines;
}

// mods.md, A source mod, story 4, and Build, story 3: every other file the folder holds goes to the trash, and the
// manifest, written last, names the repository as its one package and each file the build made.
async function recorded({ adapter, trash }: BuildDeps, mod: SourceModToBuild, made: readonly MadeFile[], taken: readonly string[]): Promise<Pick<ModBuilt, 'failure' | 'trashed'>> {
  const output = outputOf(mod, made, taken);
  const ofTheOutput = new Set([...output.vouched, ...output.stepped, ...output.leftAsItWas].map((path) => path.toLowerCase()));
  try {
    const held = await adapter.filesIn(mod.folder);
    const trashed = held.filter((path) => !ofTheOutput.has(path.toLowerCase()));
    const why = await whyNotTrashed(adapter, trash, mod.folder, trashed);
    if (why !== undefined) return { failure: `The build stopped as ${why}, so its manifest was not written.` };
    await writeManifestIn(mod.folder, {
      packages: [{ kind: 'sourceRepository', name: basename(mod.sourceFolder), isSubmodule: mod.isSubmodule }],
      exclude: [], archives: [],
      files: await linesOf(adapter, mod, output, new Set(held)),
      ...mod.version === undefined ? {} : { version: mod.version },
    });
    return trashed.length === 0 ? {} : { trashed };
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
  deps: BuildDeps, mod: SourceModToBuild, landed: ModBuilt, made: readonly MadeFile[], taken: readonly string[],
): Promise<ModBuilt> {
  if (landed.failure !== undefined) return landed;
  const { steps } = mod.buildFile;
  const stepFailed = steps.length === 0 ? undefined : await deps.tasks.whyStepsFailed(steps, mod.folder);
  if (stepFailed !== undefined) return { ...landed, failure: `The build stopped as its ${stepFailed}, so its manifest was not written.` };
  return { ...landed, ...await recorded(deps, mod, made, taken) };
}

/** The mod built, refused before anything was written, or mEdit's refusal of the whole call. */
export async function buildSourceMod(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built> {
  const { name, folder, buildFile, exclude } = mod;
  const refusal = refusedBeforeWriting(mod, pass);
  if (refusal !== undefined) return refusal;
  let taken: Taken;
  try {
    taken = await takenWritten(deps.adapter, mod);
  } catch (err) {
    return { landed: { mod: name, compiled: [], refused: [], archivesRefused: [], overwritten: [], failure: `The build stopped before compiling, as a file its packages give could not be written: ${errorMessage(err)}` } };
  }
  const answer = await deps.client.build([{
    name, sourceFolder: mod.sourceFolder, folder, exclude: [...exclude], taken: [...taken.at],
    archives: buildFile.archives.map(({ path, files }) => ({ path, files: [...files] })),
  }], pass.facts);
  if (isRefused(answer)) return answer;
  const [mEditRefused] = answer.refused;
  if (mEditRefused !== undefined) return { refusal: mEditRefused };
  const [built] = answer.landed;
  if (built === undefined) return refusedAs(name, 'mEdit answered nothing for it');
  const { made, ...outcome } = built;
  return { landed: await finished(deps, mod, { ...outcome, overwritten: [...taken.overwritten, ...outcome.overwritten].sort() }, made, taken.at) };
}
