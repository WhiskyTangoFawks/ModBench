// source.md, Build: the build file's steps run in order, mEdit running each built-in one, and the extension records in the mod's
// manifest what the build made (ADR-0016, ADR-0027).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildMod, type BuildOutcome, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { exclusionsOfFiles, folderAgainst, isUnderAny, manifestIn, writeManifestIn, type BuildFile, type BuildStep, type Manifest, type RunStep } from '../manifestAdapter/manifestAdapter';
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

/** A source mod to build: its folder, the paths the modlist excludes from it and those its manifest ignores, and the
 *  repository that builds it with the build file it holds. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly exclude: readonly string[];
  readonly ignore: readonly string[];
  readonly sourceFolder: string;
  readonly buildFile: BuildFile;
}

/** What every mod's build is handed: mEdit's facts, and the label of each VS Code task this machine has. */
export interface BuildPass {
  readonly facts: BuildFacts;
  readonly tasks: ReadonlySet<string>;
}

/** A mod that built, as mEdit answers its steps without the files they made. `trashed`: each other file its folder held. */
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
  const exclude = exclusionsOfFiles(mod.exclude, files.keys());
  return { packages: [{ kind: 'repository', name: basename(mod.sourceFolder) }], exclude, ignore: mod.ignore, files };
}

// source.md, Build, story 20: each file whose bytes its manifest does not record, which no build can make again.
async function unrecordedIn(adapter: Adapter, mod: SourceModToBuild): Promise<string[]> {
  const files = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
  const against = folderAgainst({ files, exclude: mod.exclude, ignore: mod.ignore }, await adapter.folderValue(mod.folder));
  return [...against.files.flatMap(({ pathInFolder, holdsItsBytes }) => (holdsItsBytes === false && pathInFolder !== undefined ? [pathInFolder] : [])), ...against.namedByNoLine];
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

// Build, stories 3 and 8: how a step made a file. A run's is recorded by its path alone, and a file mEdit left as it was
// keeps its recorded hash while the folder holds those bytes.
type Made = 'vouched' | 'leftAsItWas' | 'byARun';

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

// Each file the folder holds that the build made, by the path the build gives it.
function filesOf(
  ownPath: Adapter['ownPath'], made: ReadonlyMap<string, Made>, folder: FolderValue, previous: ReadonlyMap<string, string | null>, ignore: readonly string[],
): Map<string, string | null> {
  const at = heldAt(folder);
  const files = new Map<string, string | null>();
  for (const [pathInFolder, how] of made) {
    const held = at(pathInFolder);
    const path = ownPath(pathInFolder);
    const recorded = previous.get(path);
    if (held === undefined || isUnderAny(ignore, path)) continue;
    if (how === 'byARun') files.set(path, null);
    else if (how === 'leftAsItWas') {
      if (recorded !== undefined && recorded !== null && held.hash === recorded) files.set(path, recorded);
    } else if (held.hash === undefined) throw new Error(`'${pathInFolder}' could not be read: ${held.unreadable ?? ''}`);
    else files.set(path, held.hash);
  }
  return files;
}

const notMadeIn = (made: ReadonlyMap<string, Made>, folder: FolderValue, ignore: readonly string[]): string[] => {
  const named = new Set([...made.keys()].map((path) => path.toLowerCase()));
  return [...folder.files].filter(([path, file]) => !made.has(path) && !(folder.ignoresCase && named.has(path.toLowerCase())) && !isUnderAny(ignore, file.path))
    .map(([path]) => path).sort();
};

type Built = { readonly landed: ModBuilt } | { readonly refusal: BuildRefusal } | WriteRefused;

const refusedAs = (mod: string, why: string, lacksATask = false): { readonly refusal: BuildRefusal } =>
  ({ refusal: { item: mod, reason: notBuilt(why), ...lacksATask ? { lacksATask: true } : {} } });

// Why this machine cannot run a build file's steps: each task it has none of, with the page its tool comes from (Build, story 13).
function toolsWithoutTask({ steps }: BuildFile, tasks: ReadonlySet<string>): string | undefined {
  const pages = new Map<string, string | undefined>();
  for (const step of steps) if (step.kind === 'task' && !tasks.has(step.task) && pages.get(step.task) === undefined) pages.set(step.task, step.page);
  const named = [...pages].map(([task, page]) => (page === undefined ? `'${task}'` : `'${task}' (${page})`));
  const last = named.pop();
  if (last === undefined) return undefined;
  return named.length === 0 ? `this machine has no task for its tool ${last}` : `this machine has no task for its tools ${named.join(', ')} and ${last}`;
}

// What the steps made, before the manifest records it; `failure`: why the build stopped.
interface Ran {
  readonly outcome: ModBuilt;
  readonly made: ReadonlyMap<string, Made>;
  readonly failure?: string;
}

// A write changes the time of a file's change, whatever it writes, and a tool can keep the rest across one.
async function stampsIn(adapter: Adapter, folder: string): Promise<ReadonlyMap<string, string>> {
  const stamps = new Map<string, string>();
  for (const path of await adapter.filesIn(folder)) {
    const stamp = await adapter.fileStamp(join(folder, path));
    stamps.set(path, stamp.kind === 'read' ? `${stamp.answer.size}:${stamp.answer.modifiedNs}:${stamp.answer.changedNs}` : `unreadable:${stamp.reason}`);
  }
  return stamps;
}

// Build, story 3: each file a task or a script makes or changes is made by it.
async function stepRan(deps: BuildDeps, mod: SourceModToBuild, step: RunStep, made: Map<string, Made>): Promise<string | undefined> {
  const before = await stampsIn(deps.adapter, mod.folder);
  const failed = await deps.tasks.whyStepFailed(step, { sourceFolder: mod.sourceFolder, folder: mod.folder });
  for (const [path, stamp] of await stampsIn(deps.adapter, mod.folder)) if (before.get(path) !== stamp) made.set(path, 'byARun');
  return failed;
}

const wireStep = (step: Exclude<BuildStep, RunStep>): BuildMod['step'] =>
  (step.kind === 'pack' ? { pack: step.archives.map(({ path, files }) => ({ path, files: [...files] })) } : { [step.kind]: [...step.paths] });

type StepBuilt = BuildOutcome['landed'][number];

type StepAnswer = StepBuilt | { readonly why: string } | WriteRefused;

async function builtByMEdit(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass, step: BuildMod['step']): Promise<StepAnswer> {
  const answer = await deps.client.build([{ name: mod.name, sourceFolder: mod.sourceFolder, folder: mod.folder, exclude: [...mod.exclude], ignore: [...mod.ignore], step }], pass.facts);
  if (isRefused(answer)) return answer;
  const [refusal] = answer.refused;
  if (refusal !== undefined) return { why: refusal.reason };
  return answer.landed[0] ?? { why: 'mEdit answered nothing for it' };
}

// source.md, Build, stories 17 and 20: what a step moved aside, the plugin source a decompile replaced and
// the loose files a pack packed, goes to the trash.
async function whyAsideNotTrashed(deps: BuildDeps, mod: SourceModToBuild, { replaced, packed }: StepBuilt): Promise<string | undefined> {
  const packedNotIgnored = (packed ?? []).filter((path) => !isUnderAny(mod.ignore, deps.adapter.ownPath(path)));
  return await whyNotTrashed(deps.adapter, deps.trash, mod.sourceFolder, replaced ?? []) ?? whyNotTrashed(deps.adapter, deps.trash, mod.folder, packedNotIgnored);
}

const joined = (outcome: ModBuilt, { compiled, refused, archivesRefused, ignored, uncommitted, unpushed }: StepBuilt): ModBuilt => ({
  ...outcome, compiled: [...outcome.compiled, ...compiled], refused: [...outcome.refused, ...refused], archivesRefused: [...outcome.archivesRefused, ...archivesRefused],
  ...ignored === undefined && outcome.ignored === undefined ? {} : { ignored: [...outcome.ignored ?? [], ...ignored ?? []] },
  ...uncommitted === true ? { uncommitted } : {}, ...unpushed === true ? { unpushed } : {},
});

// A step that refused a plugin or an archive stops the steps after it.
function whyStoppedAfter({ failure, refused, archivesRefused }: StepBuilt, at: number, steps: number): string | undefined {
  const refusedHere = refused.length + archivesRefused.length;
  if (failure !== undefined || refusedHere === 0 || at === steps - 1) return failure;
  return `The build stopped after its step ${at + 1}, which refused ${refusedHere === 1 ? 'a file' : `${refusedHere} files`}.`;
}

// source.md, Build, stories 1 and 18: each step runs in order, and a failed step stops the mod's build. A first step that
// fails refuses the mod.
async function builtByItsSteps(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built | Ran> {
  const made = new Map<string, Made>();
  let outcome: ModBuilt = { mod: mod.name, compiled: [], refused: [], archivesRefused: [] };
  const ran = (failure?: string): Ran => ({ outcome, made, ...failure === undefined ? {} : { failure } });
  for (const [at, step] of mod.buildFile.steps.entries()) {
    if (step.kind === 'task' || step.kind === 'script' || step.kind === 'defaultScript') {
      const failed = await stepRan(deps, mod, step, made);
      if (failed !== undefined) return ran(`The build stopped as its ${failed}.`);
      continue;
    }
    const built = await builtByMEdit(deps, mod, pass, wireStep(step));
    if (isRefused(built) || 'why' in built) {
      const why = isRefused(built) ? `mEdit refused it: ${built.message}` : built.why;
      if (at > 0) return ran(`The build stopped at its step ${at + 1}: ${why.replace(/\.$/, '')}.`);
      return isRefused(built) ? built : refusedAs(mod.name, why);
    }
    for (const { path, vouchedFor } of built.made) made.set(path, vouchedFor ? 'vouched' : 'leftAsItWas');
    outcome = joined(outcome, built);
    const notTrashed = await whyAsideNotTrashed(deps, mod, built);
    if (notTrashed !== undefined) return ran(`The build stopped at its step ${at + 1}, as ${notTrashed}.`);
    const stopped = whyStoppedAfter(built, at, mod.buildFile.steps.length);
    if (stopped !== undefined) return ran(stopped);
  }
  return ran();
}

// source.md, Build, story 10: a build that stops records each file it wrote, and keeps every other line its manifest held.
async function stoppedAs({ adapter }: BuildDeps, mod: SourceModToBuild, made: ReadonlyMap<string, Made>, failure: string): Promise<string> {
  try {
    const folder = await adapter.folderValue(mod.folder);
    const previous = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
    await writeManifestIn(mod.folder, sourceModManifest(mod, new Map([...previous, ...filesOf(adapter.ownPath, made, folder, previous, mod.ignore)])));
    return failure;
  } catch (err) {
    return `${failure} Its manifest could not record what it wrote: ${errorMessage(err)}`;
  }
}

// ADR-0027: each file the folder holds that no step made goes to the trash, and the manifest names the repository and each
// file the build made.
async function finished(deps: BuildDeps, mod: SourceModToBuild, { outcome, made }: Ran): Promise<ModBuilt> {
  const { adapter } = deps;
  let folder: FolderValue;
  try {
    folder = await adapter.folderValue(mod.folder);
  } catch (err) {
    return { ...outcome, failure: await stoppedAs(deps, mod, made, `The build stopped after its steps, as its folder could not be read: ${errorMessage(err)}`) };
  }
  const trashed = notMadeIn(made, folder, mod.ignore);
  const withTrashed: ModBuilt = { ...outcome, ...trashed.length === 0 ? {} : { trashed } };
  const why = await whyNotTrashed(adapter, deps.trash, mod.folder, trashed);
  if (why !== undefined) return { ...withTrashed, failure: await stoppedAs(deps, mod, made, `The build stopped as ${why}.`) };
  try {
    const previous = (await heldManifest(mod.folder))?.files ?? new Map<string, string | null>();
    await writeManifestIn(mod.folder, sourceModManifest(mod, filesOf(adapter.ownPath, made, folder, previous, mod.ignore)));
    return withTrashed;
  } catch (err) {
    return { ...withTrashed, failure: `The build could not write its manifest: ${errorMessage(err)}` };
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
  // source.md, Build, story 20: what no manifest records goes to the trash before anything is written.
  const ran = await deps.adapter.trashingReplaced(mod.folder, unrecorded, deps.trash, () => builtByItsSteps(deps, mod, pass));
  if ('notTrashed' in ran) return refusedAs(mod.name, ran.notTrashed);
  const { answer } = ran;
  if (!('made' in answer)) return answer;
  if (answer.failure !== undefined) return { landed: { ...answer.outcome, failure: await stoppedAs(deps, mod, answer.made, answer.failure) } };
  return { landed: await finished(deps, mod, answer) };
}
