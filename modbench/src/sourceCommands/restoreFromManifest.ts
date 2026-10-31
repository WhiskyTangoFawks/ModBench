// modlist-repository.md, Restore from manifest: each mod's folder made what its manifest says, read and written through the
// Instance adapter; a source mod rebuilt by mEdit from its repository, a submodule at the commit the instance repository pins.

import { join } from 'node:path';
import { isRefused, type MEditClient } from '../client';
import type { InstanceAdapter, OtherManifest } from '../instanceAdapter/instanceAdapter';
import {
  buildFileIn, exclusionsOf, folderAgainst, manifestIn, metadataOf, metadataOverwritten, packagesAsked, repositoryOf, sourceModsOf, type BuildFile, type FolderAgainst, type Manifest,
  type SourceMods,
} from '../manifestAdapter/manifestAdapter';
import type { Nexus } from '../nexus/nexus';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { foldersOf, namesOf, type Folders } from './folders';
import { archiveVariants, buildSourceMod, whyNotTrashed, type BuildPass } from './buildSourceMod';
import { namedGameFolder, type NamedGameFolder } from './gameFolderFacts';
import { inModOrder } from './inModOrder';
import { namedDownloadedFiles } from './namedDownloadedFiles';
import { downloadedNow, packagesRead, type PackagesHeld, type PackagesRead } from './packagesRead';
import { metadataUnreadable } from './sourceCommands';
import type { StepTasks } from './steps';
import { whyNotIndexed } from './whyNotIndexed';

type Adapter = Pick<InstanceAdapter,
  'reading' | 'modOrder' | 'entryKey' | 'sourceRepositories' | 'downloadedFile' | 'gamePlaces' | 'gameRelease' | 'gameFiles' | 'textHash' | 'modMetadata'
  | 'unwritableMetadata' | 'writeModMetadata' | 'modFolderPath' | 'foldersRefused' | 'otherManifests' | 'exclusionMark' | 'folderValue' | 'filesIn' | 'originFileHash' | 'packageEntries' | 'keepPackageEntries' | 'writeFilesIn' | 'trashFileIn' | 'submodule'
  | 'unclonedSubmodules' | 'downloadedFileHolding' | 'copyDownloadedFile' | 'nexusFileAt' | 'putDownloadedFile' | 'repositoryOnDisk' | 'refuseUnpublishedPins' | 'writePathTokens'>;

export interface RestoreDeps {
  readonly client: Pick<MEditClient, 'cloneSubmodules' | 'build' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  readonly adapter: Adapter;
  readonly nexus: Pick<Nexus, 'download'>;
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

// A mod restore would destroy something in: each file whose bytes differ from its package's, each file no line names,
// and whether it writes another version or page over its metadata's.
interface ModRestoreDestroys {
  readonly mod: string;
  readonly differing: readonly string[];
  readonly namedByNoLine: readonly string[];
  readonly metadataDiffers: boolean;
}

export interface WhatRestoreDestroys {
  readonly destroys: readonly ModRestoreDestroys[];
  readonly refused: readonly ItemRefusal<string>[];
}

/** Every other manifest (modlist-repository.md, Every mod, story 1), and each folder the search could not read, or the
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

interface Pass {
  readonly deps: RestoreDeps;
  readonly folders: Folders;
  readonly sourceMods: SourceMods;
  readonly game: NamedGameFolder | string;
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

async function compared(adapter: Adapter, manifest: Manifest, folder: string, packages: PackagesRead): Promise<FolderAgainst> {
  const entries = new Map<string, ReadonlyMap<string, string>>();
  for (const key of packagesAsked(manifest).entries) {
    const held = packages.entries.get(key) ?? await adapter.packageEntries(key);
    if (held !== undefined) entries.set(key, held);
  }
  return folderAgainst(manifest, await adapter.folderValue(folder), entries);
}

type Answer = { readonly landed: ModRestored } | { readonly refusal: string };

// modlist-repository.md, Restore from manifest, story 4: an installation file the downloads folder lacks is copied from the file that holds its bytes, else downloaded.
async function packagesFor(pass: Pass, manifest: Manifest): Promise<PackagesRead | { readonly refusal: string }> {
  const { adapter, nexus } = pass.deps;
  const named = manifest.packages.flatMap((pkg) => (pkg.kind === 'installationFile' ? [{ name: pkg.name, size: pkg.size, hash: pkg.hash, ...(pkg.page === undefined ? {} : { page: pkg.page }) }] : []));
  const found = await namedDownloadedFiles({ adapter, nexus }, [{ installationFiles: named }], {
    onDownload: (file) => { pass.options.onProgress?.({ phase: 'Downloading', file }); }, signal: pass.options.signal,
  });
  const downloaded: PackagesHeld['downloaded'] = (name) => {
    const why = found.unreadable(name);
    return why === undefined ? { kind: 'read', answer: found.handed(name) } : { kind: 'unreadable', reason: why };
  };
  const packages = await packagesRead(adapter, manifest, { downloaded, game: pass.game });
  if (packages.lacks.length === 0) return packages;
  const why = named.flatMap(({ name }) => found.why(name).map(sentence));
  return { refusal: `${skipped(packages.lacks.join('; '))}${why.join('')}` };
}

// modlist-repository.md, The manifest, story 3: the manifest's version and installation file, and what else the
// metadata holds kept.
async function metadataWrittenOrWhy(pass: Pass, mod: string, manifest: Manifest): Promise<string | undefined> {
  if (!pass.folders.isMod(mod)) return undefined;
  try {
    await pass.deps.adapter.writeModMetadata(mod, metadataOf(manifest));
  } catch (err) {
    return `its metadata could not be written: ${errorMessage(err)}`;
  }
  return undefined;
}

async function whyNotFinished(pass: Pass, mod: string, manifest: Manifest, folder: string, namedByNoLine: readonly string[]): Promise<string | undefined> {
  const { adapter, trash } = pass.deps;
  return await whyNotTrashed(adapter, trash, folder, namedByNoLine) ?? await metadataWrittenOrWhy(pass, mod, manifest);
}

// A status on this machine reads a game folder package's entries from the hash index.
async function packageEntriesKept(adapter: Adapter, manifest: Manifest, packages: PackagesRead): Promise<readonly string[]> {
  const notes: string[] = [];
  for (const pkg of manifest.packages) {
    const hash = pkg.kind === 'gameFolder' ? pkg.hash : undefined;
    const entries = hash === undefined ? undefined : packages.entries.get(hash);
    const why = hash === undefined || entries === undefined ? undefined : await adapter.keepPackageEntries(hash, entries);
    if (why !== undefined) notes.push(`the files it takes from the game folder could not be recorded, so its status reads them as differing: ${why}`);
  }
  return notes;
}

// modlist-repository.md, Restore from manifest, story 1: every file whose bytes differ written, and every file no line names
// sent to the trash.
async function restoreFromPackages(pass: Pass, mod: string, folder: string, manifest: Manifest): Promise<Answer> {
  const { adapter } = pass.deps;
  const packages = await packagesFor(pass, manifest);
  if ('refusal' in packages) return packages;
  let against: FolderAgainst;
  try {
    against = await compared(adapter, manifest, folder, packages);
  } catch (err) {
    return { refusal: skipped(`a file could not be read: ${errorMessage(err)}`) };
  }
  const writes = against.lines.flatMap(({ line, onDisk, holdsItsBytes }) => {
    const from = packages.packageFiles.get(line.path);
    return from === undefined || holdsItsBytes === true ? [] : [{ path: onDisk ?? line.path, from }];
  });
  try {
    if (writes.length > 0) await adapter.writeFilesIn(folder, writes);
  } catch (err) {
    return { refusal: notFinished(errorMessage(err)) };
  }
  const notes = await packageEntriesKept(adapter, manifest, packages);
  const why = await whyNotFinished(pass, mod, manifest, folder, against.namedByNoLine);
  if (why !== undefined) return { refusal: notFinished(why) };
  return { landed: { mod, written: writes.map(({ path }) => path), namedByNoLine: against.namedByNoLine, ...(notes.length === 0 ? {} : { notes }) } };
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

// ADR-0022: built only at the commit the instance repository pins.
async function clonedAtThePin(pass: Pass, name: string): Promise<Cloned> {
  const { adapter, client } = pass.deps;
  const pinned = await adapter.submodule(name);
  if ('lacks' in pinned) return { refusal: `${skipped(`its submodule '${name}' is missing`)}${sentence(pinned.lacks)}` };
  const cloned = await client.cloneSubmodules([{ folder: pinned.folder, pin: pinned.pin, ...(pinned.branch === undefined ? {} : { branch: pinned.branch }) }]);
  if (isRefused(cloned)) return { refusal: skipped(`its submodule could not be cloned or read: ${cloned.message}`) };
  const [refused] = cloned.refused;
  if (refused !== undefined) return { refusal: skipped(refused.refusal === 'AtAnotherCommit' ? refused.message : `its submodule could not be cloned or read: ${refused.message}`) };
  const leftDetached = cloned.applied[0]?.leftDetached;
  return leftDetached ? { leftDetached } : {};
}

// ADR-0006: what the build makes comes back as the build makes it, with the exclusions the manifest records.
async function rebuilt(pass: Pass, mod: string, folder: string, sourceFolder: string, manifest: Manifest, submodule: string | undefined): Promise<Answer> {
  const { adapter, client, tasks, trash } = pass.deps;
  const cloned = submodule === undefined ? {} : await clonedAtThePin(pass, submodule);
  if ('refusal' in cloned) return cloned;
  const held = await buildFileHeld(sourceFolder);
  if ('refusal' in held) return held;
  const { buildFile } = held;
  const packages = await packagesFor(pass, buildFile);
  if ('refusal' in packages) return packages;
  const before = await hashesIn(adapter, folder);
  const exclude = exclusionsOf(manifest, [], adapter.exclusionMark);
  const outcome = await buildSourceMod(
    { client, adapter, tasks, trash }, { name: mod, folder, exclude, sourceFolder, buildFile, packages, metadata: metadataOf(manifest), isSubmodule: submodule !== undefined }, pass.build);
  if (isRefused(outcome)) return { refusal: `was not built: ${outcome.message.replace(/\.$/, '')}.` };
  if ('refusal' in outcome) return { refusal: outcome.refusal.reason };
  const built = outcome.landed;
  const leftAsItWas = [...built.failure === undefined ? [] : [built.failure], ...built.refused.map(({ reason }) => reason), ...built.archivesRefused.map(({ reason }) => reason)];
  if (leftAsItWas.length > 0) return { refusal: `was not finished: ${leftAsItWas.map((why) => why.replace(/\.$/, '')).join('; ')}.` };
  const recorded = await manifestHeld(folder);
  if (recorded === undefined || 'refusal' in recorded) return { refusal: notFinished(recorded?.refusal ?? 'its build wrote no manifest') };
  let after: Map<string, string>;
  try {
    after = await hashesIn(adapter, folder);
  } catch (err) {
    return { refusal: notFinished(errorMessage(err)) };
  }
  const why = await metadataWrittenOrWhy(pass, mod, recorded.manifest);
  if (why !== undefined) return { refusal: notFinished(why) };
  return {
    landed: {
      mod, written: [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path).sort(),
      namedByNoLine: built.trashed ?? [],
      ...(built.uncommitted ? { uncommitted: true } : {}), ...cloned,
    },
  };
}

async function restoreMod(pass: Pass, mod: string): Promise<Answer> {
  const folder = await pass.folders.of(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const held = await manifestHeld(folder);
  if (held === undefined) return { refusal: skipped('it has no manifest') };
  if ('refusal' in held) return held;
  const repository = repositoryOf(held.manifest);
  if (repository === undefined) return restoreFromPackages(pass, mod, folder, held.manifest);
  const sourceFolder = pass.sourceMods.folderOf(mod);
  if (sourceFolder !== undefined) return rebuilt(pass, mod, folder, sourceFolder, held.manifest, repository.isSubmodule ? repository.name : undefined);
  return { refusal: skipped(repository.isSubmodule ? `its submodule '${repository.name}' is not cloned` : `the source folder holds no repository '${repository.name}', and its package has no host`) };
}

const notCloned = (why: string): string => `was not cloned: ${why.replace(/\.$/, '')}.`;

// modlist-repository.md, Restore from manifest, story 6: a submodule the source folder lacks is cloned first.
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

// modlist-repository.md, The repository, story 5: a hook does not travel with a clone, so restore writes it as git init does.
async function pushRefusalWrittenOrWhy(adapter: Adapter): Promise<string | undefined> {
  try {
    if (await adapter.repositoryOnDisk()) await adapter.refuseUnpublishedPins();
  } catch (err) {
    return errorMessage(err);
  }
  return undefined;
}

// modlist-repository.md, The repository, story 3: a clone holds a path token where its game path is until restore puts
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
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const ordered = await inModOrder(adapter, namesOf(asked, others));
  const { folders, refused: refusedFolder, notSearched } = await foldersCompared(adapter, ordered, others, sourceMods);
  const refusedNames = new Set(refusedFolder.map(({ item }) => item));
  const mods = ordered.filter((mod) => !refusedNames.has(mod));
  const pass = await passOver(deps, folders, sourceMods, options);

  const landed: ModRestored[] = [];
  const refused: ItemRefusal<string>[] = [...notClonedYet, ...refusedFolder, ...everyManifest ? [] : notSearched];
  const pending: string[] = [];
  const notIndexed = new Map<string, string>();
  for (const [at, mod] of mods.entries()) {
    if (options.signal?.aborted) {
      refused.push(...mods.slice(at).map((item) => ({ item, reason: CANCELLED })));
      break;
    }
    options.onProgress?.({ phase: 'Restoring', mod, modsDone: at, modsTotal: mods.length });
    // mods.md, Build, story 11: a source mod's script reads the plugins of the mods restored before it in the load order.
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

async function destroysIn(pass: Pass, mod: string): Promise<ModRestoreDestroys | { readonly refusal: string } | undefined> {
  const { adapter } = pass.deps;
  const folder = await pass.folders.of(mod);
  if (folder === undefined) return undefined;
  const metadata = pass.folders.isMod(mod) ? await adapter.modMetadata(mod) : undefined;
  if (metadata?.kind === 'unreadable') return { refusal: skipped(metadataUnreadable(metadata.reason)) };
  const held = await manifestHeld(folder);
  if (held === undefined) return undefined;
  if ('refusal' in held) return held;
  const says = metadataOf(held.manifest);
  const unwritable = metadata === undefined ? undefined : await adapter.unwritableMetadata(mod, says);
  if (unwritable !== undefined) return { refusal: skipped(unwritable) };
  try {
    // The listing asks before restore downloads anything, so it reads what the downloads folder holds now.
    const downloaded = await downloadedNow(adapter, held.manifest);
    const against = await compared(adapter, held.manifest, folder, await packagesRead(adapter, held.manifest, { downloaded, game: pass.game }));
    return {
      mod, differing: against.lines.flatMap(({ onDisk, holdsItsBytes }) => (holdsItsBytes === false && onDisk !== undefined ? [onDisk] : [])).sort(),
      namedByNoLine: against.namedByNoLine, metadataDiffers: metadata !== undefined && metadataOverwritten(metadata.answer, says),
    };
  } catch (err) {
    return { refusal: skipped(`a file could not be read: ${errorMessage(err)}`) };
  }
}

/** What restore from manifest of the mods would destroy, before anything is written, and each mod it would skip for a
 *  file or metadata it cannot read or write. */
export async function whatRestoreDestroys(deps: RestoreDeps, mods: readonly string[], others: readonly OtherManifest[]): Promise<WhatRestoreDestroys> {
  const { adapter } = deps;
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const names = namesOf(mods, others);
  const { folders, refused } = await foldersCompared(adapter, names, others, sourceMods);
  const refusedNames = new Set(refused.map(({ item }) => item));
  const pass = await passOver(deps, folders, sourceMods, {});
  const destroys: ModRestoreDestroys[] = [];
  const skippedMods: ItemRefusal<string>[] = [...refused];
  for (const mod of names.filter((name) => !refusedNames.has(name))) {
    const listed = await destroysIn(pass, mod);
    if (listed === undefined) continue;
    if ('refusal' in listed) skippedMods.push({ item: mod, reason: listed.refusal });
    else if (listed.differing.length + listed.namedByNoLine.length > 0 || listed.metadataDiffers) destroys.push(listed);
  }
  return { destroys, refused: skippedMods };
}
