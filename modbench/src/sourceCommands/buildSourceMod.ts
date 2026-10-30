// mods.md, Build: the extension writes what a source mod's build file takes from its packages, mEdit compiles and packs what
// it is handed, and the extension records in the mod's manifest what the build made (ADR-0016).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildOutcome, type MadeFile, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { lineAtFolderPath, writeManifestIn, type Manifest, type ManifestFile } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { ba2VersionsOf } from '../tables/gamePaths';
import { toolsWithoutTask, type PackagesRead } from './packagesRead';
import type { StepTasks } from './steps';

type Adapter = Pick<InstanceAdapter, 'exclusionMark' | 'writeFilesIn' | 'filesIn' | 'originFileHash' | 'keepPackageEntries'>;

export interface BuildDeps {
  readonly client: Pick<MEditClient, 'build'>;
  readonly adapter: Adapter;
  readonly tasks: StepTasks;
}

/** A source mod to build: its folder, the repository that builds it and the build file it holds, where this machine holds
 *  its packages, and the version and host its manifest records. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly sourceFolder: string;
  readonly buildFile: Manifest;
  readonly packages: PackagesRead;
  readonly version: string | undefined;
  readonly isSubmodule: boolean;
}

/** What every mod's build is handed: mEdit's facts, and the label of each VS Code task this machine has. */
export interface BuildPass {
  readonly facts: BuildFacts;
  readonly tasks: ReadonlySet<string>;
}

/** A mod that built, as mEdit answers it without the files it made. */
export type ModBuilt = Omit<BuildOutcome['landed'][number], 'made'> & { readonly notes?: readonly string[] };

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
  const { buildFile, packages, folder } = mod;
  const packed = new Set(buildFile.archives.flatMap(({ files }) => files).map((path) => path.toLowerCase()));
  const at: string[] = [];
  const overwritten: string[] = [];
  const writes: Parameters<Adapter['writeFilesIn']>[1][number][] = [];
  for (const line of buildFile.files) {
    const from = packages.packageFiles.get(line.path);
    if (from === undefined) continue;
    const path = lineAtFolderPath(buildFile, line, adapter.exclusionMark).path;
    at.push(path);
    const there = await adapter.originFileHash(join(folder, path));
    if (there.kind === 'read' && there.answer.hash === packages.hashes.get(line.path)) continue;
    if (there.kind === 'read' && !packed.has(line.path.toLowerCase())) overwritten.push(path);
    writes.push({ path, from });
  }
  if (writes.length > 0) await adapter.writeFilesIn(folder, writes);
  return { at, overwritten };
}

// A status on this machine reads each file the build made as its repository's entry in the hash index, but one mEdit made
// that the source does not vouch for (modlist-repository.md, Status).
async function entriesKept(adapter: Adapter, mod: SourceModToBuild, recorded: readonly string[], unvouched: ReadonlySet<string>): Promise<string | undefined> {
  const hashes = new Map<string, string>();
  for (const path of recorded.filter((one) => !unvouched.has(one))) {
    const read = await adapter.originFileHash(join(mod.folder, path));
    if (read.kind === 'read') hashes.set(path, read.answer.hash);
  }
  return await adapter.keepPackageEntries(basename(mod.sourceFolder), hashes);
}

// mods.md, Build, story 3: the manifest, written last, names the repository as its one package, and each file the build made
// that the folder holds: each mEdit made, each the build file takes and each a step makes.
async function recorded(adapter: Adapter, mod: SourceModToBuild, made: readonly MadeFile[], taken: readonly string[]): Promise<Pick<ModBuilt, 'failure' | 'notes'>> {
  const { buildFile } = mod;
  try {
    const held = new Set(await adapter.filesIn(mod.folder));
    const stepped = buildFile.files.filter(({ entry }) => entry.kind === 'madeByStep').map(({ path }) => path);
    const paths = [...new Set([...made.map(({ path }) => path), ...taken, ...stepped])].filter((path) => held.has(path));
    await writeManifestIn(mod.folder, {
      packages: [{ kind: 'sourceRepository', name: basename(mod.sourceFolder), isSubmodule: mod.isSubmodule }],
      exclude: [], archives: [], steps: [], tools: [],
      files: paths.map((path): ManifestFile => ({ path, entry: { kind: 'held' } })),
      ...mod.version === undefined ? {} : { version: mod.version },
    });
    const why = await entriesKept(adapter, mod, paths, new Set(made.filter(({ vouchedFor }) => !vouchedFor).map(({ path }) => path)));
    return why === undefined ? {} : { notes: [`the files it built could not be recorded, so its status reads them as differing: ${why}`] };
  } catch (err) {
    return { failure: `The build could not write its manifest: ${errorMessage(err)}` };
  }
}

type Built = { readonly landed: ModBuilt } | { readonly refusal: BuildRefusal } | WriteRefused;

const refusedAs = (mod: string, why: string, lacksATask = false): { readonly refusal: BuildRefusal } =>
  ({ refusal: { item: mod, reason: notBuilt(why), ...lacksATask ? { lacksATask: true } : {} } });

// mods.md, Build, stories 4 and 13: what refuses the mod is checked before its first write.
function refusedBeforeWriting({ name, folder, buildFile, packages }: SourceModToBuild, pass: BuildPass): { readonly refusal: BuildRefusal } | undefined {
  if (buildFile.output?.toLowerCase() !== basename(folder).toLowerCase()) {
    return refusedAs(name, `its build file names the output folder '${buildFile.output ?? ''}', not its folder '${basename(folder)}'`);
  }
  const noTask = toolsWithoutTask(buildFile, pass.tasks);
  if (noTask !== undefined) return refusedAs(name, noTask, true);
  return packages.lacks.length > 0 ? refusedAs(name, packages.lacks.join('; ')) : undefined;
}

// mods.md, Build, stories 1 and 3: the steps run once mEdit made the folder, and the manifest is written last.
async function finished(
  { adapter, tasks }: BuildDeps, mod: SourceModToBuild, landed: ModBuilt, made: readonly MadeFile[], taken: readonly string[],
): Promise<ModBuilt> {
  if (landed.failure !== undefined) return landed;
  const { steps } = mod.buildFile;
  const stepFailed = steps.length === 0 ? undefined : await tasks.whyStepsFailed(steps, mod.folder);
  if (stepFailed !== undefined) return { ...landed, failure: `The build stopped as its ${stepFailed}, so its manifest was not written.` };
  return { ...landed, ...await recorded(adapter, mod, made, taken) };
}

/** The mod built, refused before anything was written, or mEdit's refusal of the whole call. */
export async function buildSourceMod(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built> {
  const { name, folder, buildFile } = mod;
  const refusal = refusedBeforeWriting(mod, pass);
  if (refusal !== undefined) return refusal;
  let taken: Taken;
  try {
    taken = await takenWritten(deps.adapter, mod);
  } catch (err) {
    return { landed: { mod: name, compiled: [], refused: [], archivesRefused: [], overwritten: [], failure: `The build stopped before compiling, as a file its packages give could not be written: ${errorMessage(err)}` } };
  }
  const answer = await deps.client.build([{
    name, sourceFolder: mod.sourceFolder, folder, exclude: [...buildFile.exclude], taken: [...taken.at],
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
