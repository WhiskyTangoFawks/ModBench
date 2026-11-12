// instance-repository.md, Restore from manifest: each mod's folder made what its manifest says, read and written through the
// Instance adapter; a source mod rebuilt by mEdit from its repository, a submodule at the commit the instance repository pins.

import { basename, join } from 'node:path';
import { isRefused, type MEditClient } from '../client';
import type { InstallationFile, InstanceAdapter, OtherManifest, PackageFile, Submodule } from '../instanceAdapter/instanceAdapter';
import {
  buildFileIn, exclusionsOf, flaggedHashesIn, folderAgainst, installationFileLack, manifestIn, repositoryOf, sourceModsOf, type BuildFile, type FolderAgainst, type Manifest,
  type ManifestPackage, type SourceMods,
} from '../manifestAdapter/manifestAdapter';
import type { Nexus } from '../nexus/nexus';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { foldersOf, namesOf, type Folders } from './folders';
import { possibleHashesOf } from './possibleHashes';
import { archiveVariants, buildSourceMod, whyNotTrashed, type BuildPass } from './buildSourceMod';
import { namedGameFolder, type NamedGameFolder } from './gameFolderFacts';
import { setAsideHeldWhole } from './setAsideHeldWhole';
import { inModOrder } from './inModOrder';
import { namedDownloadedFiles } from './namedDownloadedFiles';
import type { StepTasks } from './steps';
import { whyNotIndexed, type LoadOrderSnapshot } from './whyNotIndexed';

type Adapter = Pick<InstanceAdapter,
  'reading' | 'modOrder' | 'entryKey' | 'sourceModFolders' | 'downloadedFile' | 'gamePlace' | 'gameRelease' | 'gameFiles' | 'gameFilesTakenBy' | 'textHash'
  | 'nexusFileAt' | 'modFolderPath' | 'foldersRefused' | 'otherManifests' | 'exclusionMark' | 'pathInFolder' | 'ownPath' | 'folderValue' | 'unheldFolderValue' | 'filesIn' | 'originFileHash' | 'writeFilesIn'
  | 'trashFileIn' | 'trashingReplaced' | 'fileStamp' | 'submodule' | 'unclonedSubmodules' | 'downloadedFileHolding' | 'copyDownloadedFile' | 'putDownloadedFile'
  | 'repositoryOnDisk' | 'refuseUnpublishedPins' | 'writePathTokens' | 'writeInstalledFrom' | 'foldersHeldWhole'>;

type FolderValue = Awaited<ReturnType<InstanceAdapter['folderValue']>>;

export interface RestoreDeps {
  readonly client: Pick<MEditClient, 'cloneSubmodules' | 'setPluginFileFlags' | 'getFlaggedPluginHashes' | 'build' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  readonly adapter: Adapter;
  readonly nexus: Pick<Nexus, 'download'>;
  readonly loadOrderSnapshot: LoadOrderSnapshot;
  readonly trash: MoveToTrash;
  readonly tasks: StepTasks;
}

interface ModRestored {
  readonly mod: string;
  readonly written: readonly string[];
  readonly namedByNoLine: readonly string[];
  readonly uncommitted?: true;
  readonly leftDetached?: string;
  readonly notes?: readonly string[];
}

/** Each mod restored or refused with why. pushRefusalNotWritten: why the instance repository does not refuse a push of a pin
 *  its source mod's remote lacks. pathTokensNotWritten: why a path token stays in the working tree. */
export interface RestoreResult {
  readonly landed: readonly ModRestored[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly pushRefusalNotWritten?: string;
  readonly pathTokensNotWritten?: string;
}

export type RestoreStatus =
  | { readonly phase: 'Cloning' }
  | { readonly phase: 'Downloading'; readonly file: string }
  | { readonly phase: 'Restoring'; readonly mod: string; readonly modsDone: number; readonly modsTotal: number };

/** Every other manifest (instance-repository.md, Every mod, story 1), and each folder the search could not read, or the
 *  search itself, refused on its own (commands.md, A selection is one gesture, and each item lands on its own). */
export interface OtherManifests { readonly others: readonly OtherManifest[]; readonly refused: readonly ItemRefusal<string>[] }

interface Options {
  readonly onProgress?: (status: RestoreStatus) => void;
  readonly signal?: AbortSignal;
}

const sentence = (reason: string): string => ` ${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/\.$/, '')}.`;
const skipped = (why: string): string => `was skipped: ${why.replace(/\.$/, '')}.`;
const notFinished = (why: string): string => `was not finished: ${why.replace(/\.$/, '')}. Restoring it again finishes it.`;

export async function otherManifestsOf(adapter: Pick<InstanceAdapter, 'otherManifests'>): Promise<OtherManifests> {
  try {
    const { manifests, unsearched, nested } = await adapter.otherManifests();
    return {
      others: manifests,
      refused: [...unsearched.map(({ name, reason }) => ({ item: name, reason: `was not searched for a manifest: ${reason}` })), ...nested.map(({ name, reason }) => ({ item: name, reason }))],
    };
  } catch (err) {
    return { others: [], refused: [{ item: 'every other manifest', reason: `was not searched for: ${errorMessage(err)}` }] };
  }
}

// ADR-0022: a folder is compared with every manifest's, not only the selection's.
async function foldersCompared(
  adapter: Adapter, names: readonly string[], others: readonly OtherManifest[], sourceMods: SourceMods,
): Promise<{ folders: Folders; refused: ItemRefusal<string>[]; notSearched: readonly ItemRefusal<string>[] }> {
  const search = await otherManifestsOf(adapter);
  const every = [...others, ...search.others.filter(({ name }) => !others.some((asked) => asked.name === name))];
  const { mods, modFolders } = await adapter.modOrder();
  const folders = foldersOf(adapter, every, modFolders);
  const otherNames = new Set(every.map(({ name }) => name));
  const byKey = new Map<string, string>();
  for (const name of [...names, ...mods.flatMap((entry) => (entry.kind === 'mod' ? [entry.name] : [])), ...sourceMods.folders.keys(), ...otherNames]) {
    const key = otherNames.has(name) ? name : adapter.entryKey({ kind: 'mod', name });
    if (!byKey.has(key)) byKey.set(key, name);
  }
  const folderOf = new Map<string, string>();
  await Promise.all([...byKey.values()].map(async (name) => {
    const folder = await folders.of(name);
    if (folder !== undefined) folderOf.set(name, folder);
  }));
  return { folders, refused: [...await adapter.foldersRefused(folderOf, names)], notSearched: search.refused };
}

type Held = { readonly manifest: Manifest } | { readonly refusal: string } | undefined;

async function manifestHeld(folder: string): Promise<Held> {
  try {
    const read = await manifestIn(folder);
    if (read === undefined) return undefined;
    return 'refused' in read ? { refusal: skipped(read.refused) } : read;
  } catch (err) {
    return { refusal: skipped(`its manifest could not be read: ${errorMessage(err)}`) };
  }
}

// Read once the submodule is cloned, as a clone holds no build file before.
async function buildFileHeld(sourceFolder: string): Promise<{ readonly buildFile: BuildFile } | { readonly refusal: string }> {
  try {
    const read = await buildFileIn(sourceFolder);
    if (read === undefined) return { refusal: skipped(`'${sourceFolder}' holds no build file`) };
    return 'refused' in read ? { refusal: skipped(read.refused) } : { buildFile: read.buildFile };
  } catch (err) {
    return { refusal: skipped(`its build file could not be read: ${errorMessage(err)}`) };
  }
}

/** What restoring one folder from its packages asks of the instance. */
export type FolderRestoreAdapter = Pick<InstanceAdapter,
  'gameRelease' | 'downloadedFile' | 'downloadedFileHolding' | 'copyDownloadedFile' | 'putDownloadedFile' | 'gamePlace' | 'gameFilesTakenBy' | 'unheldFolderValue'
  | 'pathInFolder' | 'filesIn' | 'originFileHash' | 'writeFilesIn' | 'trashFileIn' | 'nexusFileAt' | 'textHash'>;

interface FolderPass {
  readonly deps: {
    readonly adapter: FolderRestoreAdapter;
    /** Absent for a manifest that sets no flags. */
    readonly client?: Pick<MEditClient, 'setPluginFileFlags' | 'getFlaggedPluginHashes'>;
    readonly nexus: RestoreDeps['nexus'];
    readonly trash: MoveToTrash;
  };
  readonly game: NamedGameFolder | string;
  readonly options: Options;
}

interface Pass extends FolderPass {
  readonly deps: RestoreDeps;
  readonly folders: Folders;
  readonly sourceMods: SourceMods;
  readonly build: BuildPass;
  readonly options: Options;
}

async function passOver(deps: RestoreDeps, folders: Folders, sourceMods: SourceMods, options: Options): Promise<Pass> {
  const { adapter } = deps;
  const gameRelease = await adapter.gameRelease();
  const tasks = await deps.tasks.labels();
  return {
    deps, folders, sourceMods, options, game: await namedGameFolder(adapter, gameRelease),
    build: { facts: { exclusionMark: adapter.exclusionMark, archives: archiveVariants(gameRelease) }, tasks: new Set(tasks) },
  };
}

type Answer = { readonly landed: ModRestored } | { readonly refusal: string };

type InstallationFilePackage = Extract<ManifestPackage, { kind: 'installationFile' }>;

const isInstallationFile = (pkg: ManifestPackage): pkg is InstallationFilePackage => pkg.kind === 'installationFile';

// instance-repository.md, Restore from manifest, story 4: an installation file the downloads folder lacks is copied from the
// file that holds its bytes, else downloaded.
async function installationFilesFor(pass: FolderPass, manifest: Manifest): Promise<{ readonly held: readonly InstallationFile[] } | { readonly refusal: string }> {
  const { adapter, nexus } = pass.deps;
  const named = manifest.packages.filter(isInstallationFile);
  const found = await namedDownloadedFiles({ adapter, nexus }, [{ installationFiles: named }], {
    onDownload: (file) => { pass.options.onProgress?.({ phase: 'Downloading', file }); }, signal: pass.options.signal,
  });
  const lacks = named.flatMap((pkg) => {
    const why = found.unreadable(pkg.name);
    const lack = installationFileLack(pkg, why === undefined ? { kind: 'read', answer: found.handed(pkg.name) } : { kind: 'unreadable', reason: why });
    return lack === undefined ? [] : [{ lack, why: found.why(pkg.name) }];
  });
  if (lacks.length > 0) return { refusal: `${skipped(lacks.map(({ lack }) => lack).join('; '))}${lacks.flatMap(({ why }) => why.map(sentence)).join('')}` };
  return { held: named.flatMap(({ name }) => found.handed(name) ?? []) };
}

const depotsNamed = (manifest: Manifest): string[] => manifest.packages.flatMap((pkg) => {
  const depots = pkg.kind === 'gameFolder' ? Object.entries(pkg.host?.steam.depots ?? {}) : [];
  return depots.length === 0 ? [] : [`its game folder package names ${depots.map(([id, version]) => `depot ${id} at version ${version}`).join(' and ')}`];
});

/** The mod folder whose files, by hash, stand for a source folder's. */
export interface ModFolder { readonly folder: string; readonly manifest: Manifest }

// A source folder's layout moves its files, so they are found as the mod folder's files of the same hash.
async function gameFilesFor(
  pass: FolderPass, manifest: Manifest, folder: string, paths: readonly string[], through: ModFolder | undefined,
): Promise<{ readonly files: readonly { readonly path: string; readonly hash: string; readonly from: PackageFile }[] } | { readonly lack: string }> {
  if (typeof pass.game === 'string') return { lack: pass.game };
  const wanted = new Set(paths.map((path) => manifest.files.get(path)));
  const asking = through === undefined ? { folder, paths } : { folder: through.folder, paths: [...through.manifest.files].filter(([, hash]) => wanted.has(hash ?? undefined)).map(([path]) => path) };
  const { place } = pass.game;
  const taken = await pass.deps.adapter.gameFilesTakenBy(place, asking.folder, asking.paths);
  if (taken.kind === 'unreadable') return { lack: `the game files could not be read: ${taken.reason}` };
  const files = taken.answer.gameFiles.flatMap((file) => {
    const from = { kind: 'gameFile' as const, root: place.root, path: file.path };
    const ownPaths = through === undefined ? [file.pathInFolder] : paths.filter((path) => manifest.files.get(path) === file.hash);
    return ownPaths.map((path) => ({ path, hash: file.hash, from }));
  });
  return { files };
}

// Where this machine holds the bytes of each file `manifest` names that `paths` asks for, found by hash in any package it
// names, or why the mod is skipped.
async function bytesFor(pass: FolderPass, manifest: Manifest, folder: string, paths: readonly string[], through: ModFolder | undefined): Promise<ReadonlyMap<string, PackageFile> | { readonly refusal: string }> {
  const held = await installationFilesFor(pass, manifest);
  if ('refusal' in held) return held;
  const byHash = new Map<string, PackageFile>();
  for (const file of held.held) {
    for (const entry of file.entries) if (!byHash.has(entry.hash)) byHash.set(entry.hash, { kind: 'entry', downloadedFile: file.path, entry: entry.path });
  }
  const fromTheGame = new Map<string, PackageFile>();
  const unheld = paths.filter((path) => !byHash.has(manifest.files.get(path) ?? ''));
  if (unheld.length > 0 && manifest.packages.some(({ kind }) => kind === 'gameFolder')) {
    const game = await gameFilesFor(pass, manifest, folder, unheld, through);
    if ('lack' in game) return { refusal: skipped([game.lack, ...depotsNamed(manifest)].join('; ')) };
    for (const { path, hash, from } of game.files) if (manifest.files.get(path) === hash && !fromTheGame.has(path)) fromTheGame.set(path, from);
  }
  const sourceOf = (path: string): PackageFile | undefined => fromTheGame.get(path) ?? byHash.get(manifest.files.get(path) ?? '');
  const lacked = paths.filter((path) => sourceOf(path) === undefined);
  if (lacked.length > 0) return { refusal: skipped([...lacked.map((path) => `no package it names holds the bytes of '${path}'`), ...depotsNamed(manifest)].join('; ')) };
  return new Map(paths.flatMap((path) => {
    const from = sourceOf(path);
    return from === undefined ? [] : [[path, from] as const];
  }));
}

// instance-repository.md, Restore from manifest, story 1: every file whose bytes differ written over the trashed copy, a file
// whose exclusion changed moved, and every file the manifest does not name sent to the trash.
async function restoreFromPackages(
  pass: FolderPass, mod: string, folder: string, manifest: Manifest, through?: ModFolder,
): Promise<Answer> {
  const { adapter, client } = pass.deps;
  if (client === undefined && manifest.flags.size > 0) return { refusal: skipped('its manifest sets flags, which need mEdit') };
  let against: FolderAgainst;
  try {
    const held = await adapter.unheldFolderValue(folder);
    const flagged = client === undefined
      ? new Map<string, readonly string[]>()
      : await flaggedHashesIn(manifest, held, folder, possibleHashesOf(client, adapter));
    if ('cannotTell' in flagged) return { refusal: skipped(flagged.cannotTell) };
    against = folderAgainst(manifest, held, flagged);
  } catch (err) {
    return { refusal: skipped(`a file could not be read: ${errorMessage(err)}`) };
  }
  const toWrite = against.files.filter(({ hash, holdsItsBytes }) => hash !== null && holdsItsBytes !== true);
  const bytes = await bytesFor(pass, manifest, folder, toWrite.map(({ path }) => path), through);
  if ('refusal' in bytes) return bytes;
  const writes = toWrite.flatMap(({ path }) => {
    const from = bytes.get(path);
    return from === undefined ? [] : [{ path: adapter.pathInFolder(path, manifest.exclude), from }];
  });
  const moved = toWrite.flatMap(({ path, pathInFolder }) => (pathInFolder === undefined || pathInFolder === adapter.pathInFolder(path, manifest.exclude) ? [] : [pathInFolder]));
  try {
    if (writes.length > 0) await adapter.writeFilesIn(folder, writes, pass.deps.trash);
  } catch (err) {
    return { refusal: notFinished(errorMessage(err)) };
  }
  const flagged = client === undefined ? undefined : await flagsSet({ adapter, client }, manifest, folder, writes.map(({ path }) => path));
  if (flagged !== undefined) return { refusal: notFinished(flagged) };
  const trashed = [...moved, ...against.namedByNoLine];
  const why = await whyNotTrashed(adapter, pass.deps.trash, folder, trashed);
  if (why !== undefined) return { refusal: notFinished(why) };
  return { landed: { mod, written: writes.map(({ path }) => path), namedByNoLine: against.namedByNoLine } };
}

// formats/manifest.md, `flags`: a plugin written from its package is the copy with the manifest's flags set in it.
async function flagsSet(
  pass: { readonly adapter: FolderRestoreAdapter; readonly client: NonNullable<FolderPass['deps']['client']> }, manifest: Manifest, folder: string, written: readonly string[],
): Promise<string | undefined> {
  const flagged = written.flatMap((pathInFolder) => {
    const path = [...manifest.flags.keys()].find((one) => pass.adapter.pathInFolder(one, manifest.exclude) === pathInFolder);
    const copy = path === undefined ? undefined : manifest.files.get(path);
    return path === undefined || typeof copy !== 'string' ? [] : [{ path: join(folder, pathInFolder), flags: manifest.flags.get(path) ?? {} }];
  });
  if (flagged.length === 0) return undefined;
  const answer = await pass.client.setPluginFileFlags(await pass.adapter.gameRelease(), flagged);
  if (isRefused(answer)) return answer.message;
  return answer.refused.length === 0 ? undefined : answer.refused.map(({ item, message }) => `${item}: ${message}`).join('; ');
}

async function hashesIn(adapter: Adapter, folder: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const path of await adapter.filesIn(folder)) {
    const read = await adapter.originFileHash(join(folder, path));
    hashes.set(path, read.kind === 'read' ? read.answer.hash : '');
  }
  return hashes;
}

type Cloned = { readonly leftDetached?: string } | { readonly refusal: string };

// ADR-0022: a submodule is built only at the commit the instance repository pins.
async function clonedAtThePin(pass: Pass, pinned: Submodule): Promise<Cloned> {
  const cloned = await pass.deps.client.cloneSubmodules([{ folder: pinned.folder, pin: pinned.pin, ...(pinned.branch === undefined ? {} : { branch: pinned.branch }) }]);
  if (isRefused(cloned)) return { refusal: skipped(`its submodule could not be cloned or read: ${cloned.message}`) };
  const [refused] = cloned.refused;
  if (refused !== undefined) return { refusal: skipped(refused.refusal === 'AtAnotherCommit' ? refused.message : `its submodule could not be cloned or read: ${refused.message}`) };
  const leftDetached = cloned.applied[0]?.leftDetached;
  return leftDetached ? { leftDetached } : {};
}

/** A source folder made what its manifest says, the manifest it holds having been written by version in git. Answers why not. */
export async function sourceFolderRestoredFrom(
  deps: FolderPass['deps'], mod: string, sourceFolder: string, through: ModFolder,
): Promise<string | undefined> {
  const game = await namedGameFolder(deps.adapter, await deps.adapter.gameRelease());
  const restored = await sourceFolderRestored({ deps, game, options: {} }, mod, sourceFolder, through);
  return 'refusal' in restored ? restored.refusal : undefined;
}

// ADR-0022: a folder with no manifest is left alone. Its files are reported under the folder's name, beside the mod folder's.
async function sourceFolderRestored(
  pass: FolderPass, mod: string, sourceFolder: string, through: ModFolder,
): Promise<{ readonly refusal: string } | { readonly written: readonly string[]; readonly namedByNoLine: readonly string[] }> {
  const held = await manifestHeld(sourceFolder);
  if (held === undefined) return { written: [], namedByNoLine: [] };
  if ('refusal' in held) return held;
  const answer = await restoreFromPackages(pass, mod, sourceFolder, held.manifest, through);
  if ('refusal' in answer) return answer;
  const inSource = (paths: readonly string[]): string[] => paths.map((path) => `${basename(sourceFolder)}/${path}`);
  return { written: inSource(answer.landed.written), namedByNoLine: inSource(answer.landed.namedByNoLine) };
}

const NO_FILES: FolderValue = { files: new Map(), exclude: [], ignoresCase: false };

// ADR-0006: what the build makes comes back as the build makes it, with the exclusions the manifest records.
async function rebuilt(pass: Pass, mod: string, folder: string, sourceFolder: string, manifest: Manifest, pinned: Submodule | undefined): Promise<Answer> {
  const { adapter, client, tasks, trash } = pass.deps;
  const cloned = pinned === undefined ? {} : await clonedAtThePin(pass, pinned);
  if ('refusal' in cloned) return cloned;
  const sourceRestored = await sourceFolderRestored(pass, mod, sourceFolder, { folder, manifest });
  if ('refusal' in sourceRestored) return sourceRestored;
  const held = await buildFileHeld(sourceFolder);
  if ('refusal' in held) return held;
  const { buildFile } = held;
  const before = await hashesIn(adapter, folder);
  const exclude = exclusionsOf(manifest, NO_FILES);
  const outcome = await buildSourceMod({ client, adapter, tasks, trash }, { name: mod, folder, exclude, ignore: manifest.ignore, sourceFolder, buildFile }, pass.build);
  if (isRefused(outcome)) return { refusal: `was not built: ${outcome.message.replace(/\.$/, '')}.` };
  if ('refusal' in outcome) return { refusal: outcome.refusal.reason };
  const built = outcome.landed;
  const leftAsItWas = [...built.failure === undefined ? [] : [built.failure], ...built.refused.map(({ reason }) => String(reason)), ...built.archivesRefused.map(({ reason }) => reason)];
  if (leftAsItWas.length > 0) return { refusal: `was not finished: ${leftAsItWas.map((why) => why.replace(/\.$/, '')).join('; ')}.` };
  const recorded = await manifestHeld(folder);
  if (recorded === undefined || 'refusal' in recorded) return { refusal: notFinished(recorded?.refusal ?? 'its build wrote no manifest') };
  let after: Map<string, string>;
  try {
    after = await hashesIn(adapter, folder);
  } catch (err) {
    return { refusal: notFinished(errorMessage(err)) };
  }
  return {
    landed: {
      mod, written: [...sourceRestored.written, ...[...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path).sort()],
      namedByNoLine: [...sourceRestored.namedByNoLine, ...built.trashed ?? []],
      ...(built.uncommitted ? { uncommitted: true } : {}), ...cloned,
    },
  };
}

// instance-repository.md, The manifest, story 3: the mod's metadata is written from its packages as install writes it.
async function metadataRefusal(pass: Pass, folder: string, manifest: Manifest): Promise<{ readonly refusal: string } | undefined> {
  const packages = manifest.packages.filter(isInstallationFile).map(({ name, packageVersion }) => ({ name, ...packageVersion === undefined ? {} : { version: packageVersion } }));
  if (packages.length === 0) return undefined;
  try {
    await pass.deps.adapter.writeInstalledFrom(folder, packages, pass.deps.trash);
    return undefined;
  } catch (err) {
    return { refusal: notFinished(errorMessage(err)) };
  }
}

async function restoreMod(pass: Pass, mod: string): Promise<Answer> {
  const folder = await pass.folders.of(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const held = await manifestHeld(folder);
  if (held === undefined) return { refusal: skipped('it has no manifest') };
  if ('refusal' in held) return held;
  // formats/manifest.md: a mark in a path would write the file excluded, which the manifest does not say.
  const marked = [...held.manifest.files.keys(), ...held.manifest.exclude].find((path) => pass.deps.adapter.ownPath(path) !== path);
  if (marked !== undefined) return { refusal: skipped(`its manifest names '${marked}', which carries the mod manager's mark for an excluded file`) };
  const repository = repositoryOf(held.manifest);
  if (repository === undefined) {
    const restored = await restoreFromPackages(pass, mod, folder, held.manifest);
    return 'refusal' in restored ? restored : (await metadataRefusal(pass, folder, held.manifest)) ?? restored;
  }
  const sourceFolder = pass.sourceMods.folderOf(mod);
  const pinned = await pass.deps.adapter.submodule(repository.name);
  if (sourceFolder !== undefined) return rebuilt(pass, mod, folder, sourceFolder, held.manifest, 'lacks' in pinned ? undefined : pinned);
  return { refusal: skipped('lacks' in pinned ? `the source folder holds no repository '${repository.name}', and ${pinned.lacks}` : `its submodule '${repository.name}' is not cloned`) };
}

const notCloned = (why: string): string => `was not cloned: ${why.replace(/\.$/, '')}.`;

// instance-repository.md, Restore from manifest, story 6: a submodule the source folder lacks is cloned first.
async function submodulesCloned({ adapter, client }: RestoreDeps, onProgress?: (status: RestoreStatus) => void): Promise<readonly ItemRefusal<string>[]> {
  const uncloned = await adapter.unclonedSubmodules();
  const refused: ItemRefusal<string>[] = uncloned.flatMap((submodule) => ('lacks' in submodule ? [{ item: submodule.name, reason: notCloned(submodule.lacks) }] : []));
  const toClone = uncloned.flatMap((submodule) => ('lacks' in submodule ? [] : [submodule]));
  if (toClone.length === 0) return refused;
  onProgress?.({ phase: 'Cloning' });
  const cloned = await client.cloneSubmodules(toClone.map(({ folder, pin, branch }) => ({ folder, pin, ...(branch === undefined ? {} : { branch }) })));
  if (isRefused(cloned)) return [...refused, ...toClone.map(({ name }) => ({ item: name, reason: notCloned(cloned.message) }))];
  const nameOf = new Map(toClone.map(({ name, folder }) => [folder, name]));
  return [...refused, ...cloned.refused.map(({ item, message }) => ({ item: nameOf.get(item) ?? item, reason: notCloned(message) }))];
}

// instance-repository.md, The repository, story 5: a hook does not travel with a clone, so restore writes it as git init does.
async function pushRefusalWrittenOrWhy(adapter: Adapter): Promise<string | undefined> {
  try {
    if (await adapter.repositoryOnDisk()) await adapter.refuseUnpublishedPins();
  } catch (err) {
    return errorMessage(err);
  }
  return undefined;
}

// instance-repository.md, The repository, story 3: a clone holds a path token where its game path is until restore puts
// this machine's path there, so restore writes them before it reads the game folder.
async function pathTokensWrittenOrWhy(adapter: Adapter): Promise<string | undefined> {
  try {
    return await adapter.writePathTokens();
  } catch (err) {
    return errorMessage(err);
  }
}

const CANCELLED = notFinished('the restore was cancelled');

/** Each mod's folder made what its manifest says, from the losing end of mod order; `everyManifest`: the mods are every mod,
 *  so a folder that could not be searched for a manifest refuses nothing of them. */
export async function restoreFromManifest(
  deps: RestoreDeps, asked: readonly string[], options: Options, everyManifest: boolean, others: readonly OtherManifest[],
): Promise<RestoreResult> {
  const { adapter } = deps;
  const pathTokensNotWritten = await pathTokensWrittenOrWhy(adapter);
  const notClonedYet = await submodulesCloned(deps, options.onProgress);
  const order = await adapter.modOrder();
  const sourceMods = await sourceModsOf(order.modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const ordered = await inModOrder(adapter, namesOf(asked, others));
  const { folders, refused: refusedFolder, notSearched } = await foldersCompared(adapter, ordered, others, sourceMods);
  const refusedNames = new Set(refusedFolder.map(({ item }) => item));
  const heldWhole = await setAsideHeldWhole(adapter, ordered.filter((mod) => !refusedNames.has(mod)), order.modFolders, {
    takes: (mod) => folders.isMod(mod) && sourceMods.folderOf(mod) === undefined, everyMod: everyManifest, reason: skipped('git holds its whole folder'),
  });
  const mods = heldWhole.rest;
  const pass = await passOver(deps, folders, sourceMods, options);

  const landed: ModRestored[] = [];
  const refused: ItemRefusal<string>[] = [...notClonedYet, ...refusedFolder, ...heldWhole.refused, ...everyManifest ? [] : notSearched];
  const pending: string[] = [];
  const notIndexed = new Map<string, string>();
  for (const [at, mod] of mods.entries()) {
    if (options.signal?.aborted) {
      refused.push(...mods.slice(at).map((item) => ({ item, reason: CANCELLED })));
      break;
    }
    options.onProgress?.({ phase: 'Restoring', mod, modsDone: at, modsTotal: mods.length });
    // source.md, Build, story 11: a source mod's script reads the plugins of the mods restored before it in the load order.
    if (sourceMods.folderOf(mod) !== undefined) {
      for (const [waited, why] of await whyNotIndexed(deps, pending.splice(0), options.signal)) notIndexed.set(waited, why);
    }
    const answer = await restoreMod(pass, mod);
    if ('refusal' in answer) {
      refused.push({ item: mod, reason: answer.refusal });
      continue;
    }
    landed.push(answer.landed);
    pending.push(mod);
  }
  const pushRefusalNotWritten = await pushRefusalWrittenOrWhy(adapter);
  return {
    landed: landed.filter(({ mod }) => !notIndexed.has(mod)),
    refused: [...refused, ...[...notIndexed].map(([item, why]) => ({ item, reason: `was restored, but ${why}` }))],
    ...(pushRefusalNotWritten === undefined ? {} : { pushRefusalNotWritten }),
    ...(pathTokensNotWritten === undefined ? {} : { pathTokensNotWritten }),
  };
}
