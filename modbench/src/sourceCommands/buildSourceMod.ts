// mods.md, Build: mEdit compiles and packs the source folder, the steps run, and the extension records in the mod's manifest
// what the build made (ADR-0016, ADR-0027).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildOutcome, type MadeFile, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { folderAgainst, isExcludedBy, manifestIn, writeManifestIn, type BuildFile, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { ba2VersionsOf } from '../tables/gamePaths';
import type { StepTasks } from './steps';

type Adapter = Pick<InstanceAdapter, 'pathInFolder' | 'ownPath' | 'writeFilesIn' | 'filesIn' | 'originFileHash' | 'folderValue' | 'trashFileIn' | 'trashingReplaced' | 'fileStamp'>;

type FolderValue = Awaited<ReturnType<InstanceAdapter['folderValue']>>;

export interface BuildDeps {
  readonly client: Pick<MEditClient, 'build'>;
  readonly adapter: Adapter;
  readonly tasks: StepTasks;
  readonly trash: MoveToTrash;
}

/** A source mod to build: its folder and the paths the modlist excludes from it, and the repository that builds it with the
 *  build file it holds. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly exclude: readonly string[];
  readonly sourceFolder: string;
  readonly buildFile: BuildFile;
}

/** What every mod's build is handed: mEdit's facts, and the label of each VS Code task this machine has. */
export interface BuildPass {
  readonly facts: BuildFacts;
  readonly tasks: ReadonlySet<string>;
}

/** A mod that built, as mEdit answers it without the files it made. `trashed`: each other file its folder held. */
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

const heldManifest = async (folder: string): Promise<Manifest | undefined> => {
  const read = await manifestIn(folder);
  return read !== undefined && 'manifest' in read ? read.manifest : undefined;
};

// A manifest names only the exclusions of the files it names (formats/manifest.md).
function sourceModManifest(mod: SourceModToBuild, files: ReadonlyMap<string, string | null>): Manifest {
  const exclude = mod.exclude.filter((excluded) => [...files.keys()].some((path) => isExcludedBy([excluded], path)));
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

// What mEdit made, each file by the path the folder holds it at.
interface Output {
  readonly vouched: ReadonlySet<string>;
  readonly leftAsItWas: readonly string[];
}

function outputOf(made: readonly MadeFile[]): Output {
  return { vouched: new Set(made.filter(({ vouchedFor }) => vouchedFor).map(({ path }) => path)), leftAsItWas: made.filter(({ vouchedFor }) => !vouchedFor).map(({ path }) => path) };
}

// Each file of the folder by the path it holds it at, matched in any case where the file system ignores it.
function heldAt(folder: FolderValue): (pathInFolder: string) => { readonly hash?: string; readonly unreadable?: string } | undefined {
  const byFolded = new Map([...folder.files].map(([pathInFolder, file]) => [pathInFolder.toLowerCase(), file]));
  return (pathInFolder) => {
    const held = folder.files.get(pathInFolder) ?? (folder.ignoresCase ? byFolded.get(pathInFolder.toLowerCase()) : undefined);
    if (held === undefined) return undefined;
    const { read } = held;
    return read.kind === 'read' ? { hash: read.answer.hash } : { unreadable: read.reason };
  };
}

// Build, stories 3 and 8: each file by the path the build gives it. A file mEdit left as it was keeps its recorded hash
// while the folder holds those bytes; `stepped`: each file the steps made.
function filesOf(
  ownPath: Adapter['ownPath'], output: Output, stepped: readonly string[], folder: FolderValue, previous: ReadonlyMap<string, string | null>,
): Map<string, string | null> {
  const at = heldAt(folder);
  const files = new Map<string, string | null>();
  for (const pathInFolder of output.leftAsItWas) {
    const path = ownPath(pathInFolder);
    const recorded = previous.get(path);
    if (recorded !== undefined && recorded !== null && at(pathInFolder)?.hash === recorded) files.set(path, recorded);
  }
  for (const pathInFolder of stepped) files.set(ownPath(pathInFolder), null);
  for (const pathInFolder of output.vouched) {
    const held = at(pathInFolder);
    if (held === undefined) continue;
    if (held.hash === undefined) throw new Error(`'${pathInFolder}' could not be read: ${held.unreadable ?? ''}`);
    files.set(ownPath(pathInFolder), held.hash);
  }
  return files;
}

const notInOutput = (output: Output, folder: FolderValue): string[] => {
  const exact = new Set([...output.vouched, ...output.leftAsItWas]);
  const named = new Set([...exact].map((path) => path.toLowerCase()));
  return [...folder.files.keys()]
    .filter((path) => !exact.has(path) && !(folder.ignoresCase && named.has(path.toLowerCase()))).sort();
};

// mods.md, Build, story 10: a build that stops records each file mEdit vouches for, which are written.
async function stoppedAs({ adapter }: BuildDeps, mod: SourceModToBuild, output: Output, failure: string): Promise<string> {
  try {
    const folder = await adapter.folderValue(mod.folder);
    await writtenRecorded(mod, filesOf(adapter.ownPath, { ...output, leftAsItWas: [] }, [], folder, new Map()));
    return failure;
  } catch (err) {
    return `${failure} Its manifest could not record what it wrote: ${errorMessage(err)}`;
  }
}

// Build, story 3: the manifest names the repository and each file the build made; a file left in the folder after the steps
// ran, and mEdit did not make, is a step's.
async function recorded(deps: BuildDeps, mod: SourceModToBuild, output: Output): Promise<Pick<ModBuilt, 'failure'>> {
  const { adapter } = deps;
  try {
    const folder = await adapter.folderValue(mod.folder);
    const previous = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
    await writeManifestIn(mod.folder, sourceModManifest(mod, filesOf(adapter.ownPath, output, notInOutput(output, folder), folder, previous)));
    return {};
  } catch (err) {
    return { failure: `The build could not write its manifest: ${errorMessage(err)}` };
  }
}

type Built = { readonly landed: ModBuilt } | { readonly refusal: BuildRefusal } | WriteRefused;

const refusedAs = (mod: string, why: string, lacksATask = false): { readonly refusal: BuildRefusal } =>
  ({ refusal: { item: mod, reason: notBuilt(why), ...lacksATask ? { lacksATask: true } : {} } });

// Why this machine cannot run a build file's steps: each task it has none of, with the page its tool comes from (Build, story 13).
function toolsWithoutTask({ steps }: BuildFile, tasks: ReadonlySet<string>): string | undefined {
  const pages = new Map<string, string | undefined>();
  for (const { task, page } of steps) if (!tasks.has(task) && pages.get(task) === undefined) pages.set(task, page);
  const named = [...pages].map(([task, page]) => (page === undefined ? `'${task}'` : `'${task}' (${page})`));
  const last = named.pop();
  if (last === undefined) return undefined;
  return named.length === 0 ? `this machine has no task for its tool ${last}` : `this machine has no task for its tools ${named.join(', ')} and ${last}`;
}

// What mEdit and the steps made, before the manifest records it; `failure`: why the build stopped.
interface Ran {
  readonly outcome: ModBuilt;
  readonly output: Output;
  readonly failure?: string;
}

// A write changes the time of a file's change, whatever it writes, and a tool can keep the rest across one.
async function stampsOf(adapter: Adapter, folder: string, paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const stamps = new Map<string, string>();
  for (const path of paths) {
    const stamp = await adapter.fileStamp(join(folder, path));
    stamps.set(path, stamp.kind === 'read' ? `${stamp.answer.size}:${stamp.answer.modifiedNs}:${stamp.answer.changedNs}` : `unreadable:${stamp.reason}`);
  }
  return stamps;
}

// Build, story 4 and ADR-0027: a file a step made last time that the steps did not write again is none of the folder's
// output, so it goes to the trash. `before`: the stamps of those files before the steps ran.
async function stepFilesNotMadeAgain(deps: BuildDeps, mod: SourceModToBuild, before: ReadonlyMap<string, string>): Promise<{ readonly why?: string; readonly trashed: string[] }> {
  const after = await stampsOf(deps.adapter, mod.folder, [...before.keys()]);
  const notMade = [...before].filter(([path, stamp]) => after.get(path) === stamp).map(([path]) => path);
  return { trashed: notMade, why: await whyNotTrashed(deps.adapter, deps.trash, mod.folder, notMade) };
}

// Build, story 1: mEdit makes the folder, each other file it held goes to the trash but those its steps made last time,
// and then the steps run.
async function builtAndStepped(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built | Ran> {
  const answer = await deps.client.build([{
    name: mod.name, sourceFolder: mod.sourceFolder, folder: mod.folder, exclude: [...mod.exclude],
    archives: mod.buildFile.archives.map(({ path, files }) => ({ path, files: [...files] })),
  }], pass.facts);
  if (isRefused(answer)) return answer;
  const [mEditRefused] = answer.refused;
  if (mEditRefused !== undefined) return { refusal: mEditRefused };
  const [built] = answer.landed;
  if (built === undefined) return refusedAs(mod.name, 'mEdit answered nothing for it');
  const { made, ...outcome } = built;
  const output = outputOf(made);
  if (outcome.failure !== undefined) return { outcome, output, failure: outcome.failure };
  let trashed: string[];
  let stepFiles: ReadonlyMap<string, string>;
  try {
    const folder = await deps.adapter.folderValue(mod.folder);
    const previous = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
    const stepsRemake = (path: string): boolean => mod.buildFile.steps.length > 0 && previous.get(deps.adapter.ownPath(path)) === null;
    const others = notInOutput(output, folder);
    trashed = others.filter((path) => !stepsRemake(path));
    stepFiles = await stampsOf(deps.adapter, mod.folder, others.filter(stepsRemake));
  } catch (err) {
    return { landed: { ...outcome, failure: `The build stopped before its steps, as its folder could not be read: ${errorMessage(err)}` } };
  }
  const ran = (failure: string | undefined): Ran => ({ outcome: { ...outcome, ...trashed.length === 0 ? {} : { trashed } }, output, failure });
  const why = await whyNotTrashed(deps.adapter, deps.trash, mod.folder, trashed);
  if (why !== undefined) return ran(`The build stopped as ${why}.`);
  const stepFailed = mod.buildFile.steps.length === 0 ? undefined : await deps.tasks.whyStepsFailed(mod.buildFile.steps, mod.folder);
  if (stepFailed !== undefined) return ran(`The build stopped as its ${stepFailed}.`);
  try {
    const old = await stepFilesNotMadeAgain(deps, mod, stepFiles);
    trashed = [...trashed, ...old.trashed].sort();
    return ran(old.why === undefined ? undefined : `The build stopped as ${old.why}.`);
  } catch (err) {
    return ran(`The build stopped after its steps, as their files could not be read: ${errorMessage(err)}`);
  }
}

/** The mod built, refused before anything was written, or mEdit's refusal of the whole call. */
export async function buildSourceMod(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built> {
  const noTask = toolsWithoutTask(mod.buildFile, pass.tasks);
  if (noTask !== undefined) return refusedAs(mod.name, noTask, true);
  let unrecorded: string[];
  try {
    unrecorded = await unrecordedIn(deps.adapter, mod);
  } catch (err) {
    return refusedAs(mod.name, `its folder could not be read: ${errorMessage(err)}`);
  }
  // mods.md, A source mod, story 4: what no manifest records goes to the trash before anything is written.
  const ran = await deps.adapter.trashingReplaced(mod.folder, unrecorded, deps.trash, () => builtAndStepped(deps, mod, pass));
  if ('notTrashed' in ran) return refusedAs(mod.name, ran.notTrashed);
  const { answer } = ran;
  if (!('output' in answer)) return answer;
  if (answer.failure !== undefined) return { landed: { ...answer.outcome, failure: await stoppedAs(deps, mod, answer.output, answer.failure) } };
  return { landed: { ...answer.outcome, ...await recorded(deps, mod, answer.output) } };
}
