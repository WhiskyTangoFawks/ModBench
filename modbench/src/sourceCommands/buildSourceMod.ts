// mods.md, Build: the extension writes what a source mod's packages give, mEdit compiles and packs what it is handed, and
// the extension records the manifest from what mEdit made (ADR-0016).

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildOutcome, type MadeFile, type MEditClient, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { lineAtFolderPath, writeSourceManifestIn, type Manifest, type ManifestFile, type ManifestPackage } from '../manifestAdapter/manifestAdapter';
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

/** A source mod to build: its folder, the repository that builds it and the manifest it holds, where this machine holds
 *  its packages, and the version and host its manifest records. */
export interface SourceModToBuild {
  readonly name: string;
  readonly folder: string;
  readonly sourceFolder: string;
  readonly manifest: Manifest;
  readonly packages: PackagesRead;
  readonly version: string | undefined;
  readonly isSubmodule: boolean;
}

/** What every mod's build is handed: mEdit's facts, and the label of each VS Code task this machine has. */
export interface BuildPass {
  readonly facts: BuildFacts;
  readonly tasks: ReadonlySet<string>;
}

/** A mod that built, as mEdit answers it without the files it made. `notes`: each thing the build could not record. */
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

const packageOf = (manifest: Manifest, line: ManifestFile): ManifestPackage | undefined =>
  (line.package === undefined ? manifest.packages[0] : manifest.packages.find(({ name }) => name === line.package));

const isTaken = (pkg: ManifestPackage | undefined): pkg is Exclude<ManifestPackage, { kind: 'sourceRepository' }> =>
  pkg?.kind === 'installationFile' || pkg?.kind === 'gameFolder';

// A taken line names its package, as the repository is the manifest's first.
const keptLine = (manifest: Manifest, line: ManifestFile, mark: string): ManifestFile => {
  const moved = lineAtFolderPath(manifest, line, mark);
  const pkg = packageOf(manifest, line);
  return isTaken(pkg) ? { ...moved, package: pkg.name } : moved;
};

interface Taken {
  readonly at: readonly string[];
  readonly overwritten: readonly string[];
}

// mods.md, Build, story 1: each file the manifest takes from a package, written where the folder holds it unless it holds
// those bytes, before mEdit packs it or compiles beside it.
async function takenWritten(adapter: Adapter, mod: SourceModToBuild): Promise<Taken> {
  const { manifest, packages, folder } = mod;
  const packed = new Set(manifest.archives.flatMap(({ files }) => files).map((path) => path.toLowerCase()));
  const at: string[] = [];
  const overwritten: string[] = [];
  const writes: Parameters<Adapter['writeFilesIn']>[1][number][] = [];
  for (const line of manifest.files) {
    const from = packages.packageFiles.get(line.path);
    if (from === undefined) continue;
    const path = lineAtFolderPath(manifest, line, adapter.exclusionMark).path;
    at.push(path);
    const there = await adapter.originFileHash(join(folder, path));
    if (there.kind === 'read' && there.answer.hash === packages.hashes.get(line.path)) continue;
    if (there.kind === 'read' && !packed.has(line.path.toLowerCase())) overwritten.push(path);
    writes.push({ path, from });
  }
  if (writes.length > 0) await adapter.writeFilesIn(folder, writes);
  return { at, overwritten };
}

// A status on this machine reads a game folder package's entries, and the files a build made as its repository's entries,
// from the hash index (modlist-repository.md, Status).
async function entriesKept(adapter: Adapter, mod: SourceModToBuild, made: readonly MadeFile[]): Promise<string[]> {
  const notes: string[] = [];
  for (const pkg of mod.manifest.packages) {
    const entries = pkg.kind === 'gameFolder' ? mod.packages.entries.get(pkg.hash) : undefined;
    const why = pkg.kind === 'gameFolder' && entries !== undefined ? await adapter.keepPackageEntries(pkg.hash, entries) : undefined;
    if (why !== undefined) notes.push(`the files it takes from the game folder could not be recorded, so its status reads them as differing: ${why}`);
  }
  const hashes = new Map<string, string>();
  for (const { path } of made.filter(({ vouchedFor }) => vouchedFor)) {
    const read = await adapter.originFileHash(join(mod.folder, path));
    if (read.kind === 'read') hashes.set(path, read.answer.hash);
  }
  const why = await adapter.keepPackageEntries(basename(mod.sourceFolder), hashes);
  if (why !== undefined) notes.push(`the files it made could not be recorded, so its status reads them as differing: ${why}`);
  return notes;
}

// mods.md, Build, story 1: the manifest's file lines written last, naming each file the build made that the folder holds, each
// file a package gives and each a step makes.
async function recorded(adapter: Adapter, mod: SourceModToBuild, made: readonly MadeFile[]): Promise<{ readonly notes: string[] } | { readonly failure: string }> {
  const { manifest } = mod;
  try {
    const held = new Set(await adapter.filesIn(mod.folder));
    const kept = manifest.files
      .filter((line) => line.entry.kind === 'madeByStep' || isTaken(packageOf(manifest, line)))
      .map((line) => keptLine(manifest, line, adapter.exclusionMark));
    const named = new Set(kept.map(({ path }) => path));
    const madeHeld = made.filter(({ path }) => held.has(path));
    const repository: ManifestPackage = { kind: 'sourceRepository', name: basename(mod.sourceFolder), isSubmodule: mod.isSubmodule };
    await writeSourceManifestIn(mod.sourceFolder, {
      output: manifest.output, exclude: manifest.exclude, archives: manifest.archives, steps: manifest.steps, tools: manifest.tools,
      packages: [repository, ...manifest.packages.filter(isTaken)],
      files: [...madeHeld.filter(({ path }) => !named.has(path)).map(({ path }): ManifestFile => ({ path, entry: { kind: 'held' } })), ...kept],
      ...mod.version === undefined ? {} : { version: mod.version },
    });
    return { notes: await entriesKept(adapter, mod, madeHeld) };
  } catch (err) {
    return { failure: `The build could not write its manifest: ${errorMessage(err)}` };
  }
}

type Built = { readonly landed: ModBuilt } | { readonly refusal: BuildRefusal } | WriteRefused;

const refusedAs = (mod: string, why: string, lacksATask = false): { readonly refusal: BuildRefusal } =>
  ({ refusal: { item: mod, reason: notBuilt(why), ...lacksATask ? { lacksATask: true } : {} } });

// mods.md, Build, stories 4 and 14: what refuses the mod is checked before its first write.
function refusedBeforeWriting({ name, folder, manifest, packages }: SourceModToBuild, pass: BuildPass): { readonly refusal: BuildRefusal } | undefined {
  if (manifest.output?.toLowerCase() !== basename(folder).toLowerCase()) {
    return refusedAs(name, `its manifest names the output folder '${manifest.output ?? ''}', not its folder '${basename(folder)}'`);
  }
  const noTask = toolsWithoutTask(manifest, pass.tasks);
  if (noTask !== undefined) return refusedAs(name, noTask, true);
  return packages.lacks.length > 0 ? refusedAs(name, packages.lacks.join('; ')) : undefined;
}

// mods.md, Build, story 1: the steps run once mEdit made the folder, and the manifest's file lines are written last.
async function finished({ adapter, tasks }: BuildDeps, mod: SourceModToBuild, landed: ModBuilt, made: readonly MadeFile[]): Promise<ModBuilt> {
  if (landed.failure !== undefined) return landed;
  const stepFailed = mod.manifest.steps.length === 0 ? undefined : await tasks.whyStepsFailed(mod.manifest.steps, mod.folder);
  if (stepFailed !== undefined) return { ...landed, failure: `The build stopped as its ${stepFailed}, so its manifest was not written.` };
  const record = await recorded(adapter, mod, made);
  if ('failure' in record) return { ...landed, failure: record.failure };
  return record.notes.length === 0 ? landed : { ...landed, notes: record.notes };
}

/** The mod built, refused before anything was written, or mEdit's refusal of the whole call. */
export async function buildSourceMod(deps: BuildDeps, mod: SourceModToBuild, pass: BuildPass): Promise<Built> {
  const { name, folder, manifest } = mod;
  const refusal = refusedBeforeWriting(mod, pass);
  if (refusal !== undefined) return refusal;
  let taken: Taken;
  try {
    taken = await takenWritten(deps.adapter, mod);
  } catch (err) {
    return { landed: { mod: name, compiled: [], refused: [], archivesRefused: [], overwritten: [], failure: `The build stopped before compiling, as a file its packages give could not be written: ${errorMessage(err)}` } };
  }
  const answer = await deps.client.build([{
    name, sourceFolder: mod.sourceFolder, folder, exclude: [...manifest.exclude], taken: [...taken.at],
    archives: manifest.archives.map(({ path, files }) => ({ path, files: [...files] })),
  }], pass.facts);
  if (isRefused(answer)) return answer;
  const [mEditRefused] = answer.refused;
  if (mEditRefused !== undefined) return { refusal: mEditRefused };
  const [built] = answer.landed;
  if (built === undefined) return refusedAs(name, 'mEdit answered nothing for it');
  const { made, ...outcome } = built;
  return { landed: await finished(deps, mod, { ...outcome, overwritten: [...taken.overwritten, ...outcome.overwritten].sort() }, made) };
}
