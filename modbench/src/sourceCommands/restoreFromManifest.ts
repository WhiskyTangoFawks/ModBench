// modlist-repository.md, Restore from manifest: each mod's folder made what its manifest says, read and written through the
// Instance adapter; a source mod rebuilt by mEdit from its submodule at the commit the instance repository pins.

import { basename, join } from 'node:path';
import { isRefused, type BuildFacts, type BuildMod, type MEditClient } from '../client';
import type { InstanceAdapter, OtherManifest, SourceMods } from '../instanceAdapter/instanceAdapter';
import {
  folderAgainst, manifestIn, metadataOf, metadataOverwritten, sourceManifestIn, type FolderAgainst, type Manifest,
} from '../manifestAdapter/manifestAdapter';
import type { Nexus } from '../nexus/nexus';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { foldersOf, namesOf, type Folders } from './folders';
import { namedGameFolder, wireGameFolder, type NamedGameFolder } from './gameFolderFacts';
import { inModOrder } from './inModOrder';
import { namedDownloadedFiles, wireFile } from './namedDownloadedFiles';
import { packagesRead, type PackageSources, type PackagesRead } from './packagesRead';
import { archiveVariants, metadataUnreadable } from './sourceCommands';
import type { StepTasks } from './steps';
import { whyNotIndexed } from './whyNotIndexed';

type Adapter = Pick<InstanceAdapter,
  'reading' | 'modOrder' | 'entryKey' | 'sourceMods' | 'downloadedFile' | 'gamePlaces' | 'gameRelease' | 'gameFiles' | 'textHash' | 'modMetadata'
  | 'unwritableMetadata' | 'writeModMetadata' | 'metadataFilesInModFolder' | 'modFolderPath' | 'foldersRefused' | 'otherManifests' | 'statCacheFolder'
  | 'exclusionMark' | 'filesIn' | 'fileStamp' | 'originFileHash' | 'packageEntries' | 'keepPackageEntries' | 'writeFilesIn' | 'trashFileIn' | 'submodule'
  | 'unclonedSubmodules' | 'nexusFileAt' | 'putDownloadedFile' | 'repositoryOnDisk' | 'refuseUnpublishedPins' | 'writePathTokens'>;

export interface RestoreDeps {
  readonly client: Pick<MEditClient, 'cloneSubmodules' | 'build' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  readonly adapter: Adapter;
  readonly nexus: Pick<Nexus, 'download'>;
  readonly trash: MoveToTrash;
  readonly tasks: StepTasks;
}

// A mod made what its manifest says: each file written, each file no line names sent to the trash, and what a source
// mod's rebuild left. `notes`: each thing it could not record.
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
 *  search itself, refused on its own (story 4). */
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

// modlist-repository.md, Restore from manifest, stories 13 and 14: a folder is compared with every manifest's, not only the
// selection's, and two repositories that build one mod refuse the mod.
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
  const shared = names.flatMap((item) => {
    const builders = sourceMods.buildersOf(item);
    return builders.length === 0 ? [] : [{ item, reason: `was skipped: the repositories ${builders.map((builder) => `'${builder}'`).join(' and ')} both build it.` }];
  });
  return { folders, refused: [...await adapter.foldersRefused(folderOf, names), ...shared], notSearched: search.refused };
}

type Held = { readonly manifest: Manifest } | { readonly refusal: string } | undefined;

async function manifestHeld(folder: string, sourceFolder: string | undefined): Promise<Held> {
  try {
    const read = sourceFolder === undefined ? await manifestIn(folder) : await sourceManifestIn(sourceFolder);
    if (read === undefined) return undefined;
    return 'refused' in read ? { refusal: skipped(read.refused) } : read;
  } catch (err) {
    return { refusal: skipped(`its manifest could not be read: ${errorMessage(err)}`) };
  }
}

// A source mod with a remote is built from its submodule (modlist-repository.md, Restore from manifest, story 3).
const submoduleOf = (manifest: Manifest): string | undefined => {
  const [first] = manifest.packages;
  return first?.kind === 'sourceRepository' && first.isSubmodule ? first.name : undefined;
};

interface Pass {
  readonly deps: RestoreDeps;
  readonly folders: Folders;
  readonly sourceMods: SourceMods;
  readonly game: NamedGameFolder | string;
  readonly tasks: ReadonlySet<string>;
  readonly facts: BuildFacts;
  readonly options: Options;
}

async function passOver(deps: RestoreDeps, folders: Folders, sourceMods: SourceMods, options: Options): Promise<Pass> {
  const { adapter } = deps;
  const gameRelease = await adapter.gameRelease();
  const tasks = await deps.tasks.labels();
  return {
    deps, folders, sourceMods, options, game: await namedGameFolder(adapter, gameRelease), tasks: new Set(tasks),
    facts: { exclusionMark: adapter.exclusionMark, archives: archiveVariants(gameRelease), statCache: adapter.statCacheFolder, tasks: [...tasks] },
  };
}

// Each package's entries as this machine holds them, else as the hash index does.
const compared = (adapter: Adapter, manifest: Manifest, folder: string, packages: PackagesRead): Promise<FolderAgainst> =>
  folderAgainst(manifest, folder, {
    filesIn: (at) => adapter.filesIn(at),
    fileStamp: (path) => adapter.fileStamp(path),
    originFileHash: (path) => adapter.originFileHash(path),
    packageEntries: async (hash) => packages.entries.get(hash) ?? adapter.packageEntries(hash),
  });

type Answer = { readonly landed: ModRestored } | { readonly refusal: string };

// modlist-repository.md, Restore from manifest, story 10: an installation file the downloads folder lacks is downloaded first.
async function packagesFor(pass: Pass, manifest: Manifest): Promise<PackagesRead | { readonly refusal: string }> {
  const { adapter, nexus } = pass.deps;
  const named = manifest.packages.flatMap((pkg) => (pkg.kind === 'installationFile' ? [{ name: pkg.name, hash: pkg.hash, ...(pkg.page === undefined ? {} : { page: pkg.page }) }] : []));
  const found = await namedDownloadedFiles({ adapter, nexus }, [{ installationFiles: named }], {
    onDownload: (file) => { pass.options.onProgress?.({ phase: 'Downloading', file }); }, signal: pass.options.signal,
  });
  const downloaded: PackageSources['downloaded'] = (name) => {
    const why = found.unreadable(name);
    return why === undefined ? { kind: 'read', answer: found.handed(name) } : { kind: 'unreadable', reason: why };
  };
  const packages = await packagesRead(adapter, manifest, { downloaded, game: pass.game, tasks: pass.tasks });
  if (packages.lacks.length === 0) return packages;
  const notDownloaded = named.flatMap(({ name }) => {
    const why = found.notDownloaded(name);
    return why === undefined ? [] : [sentence(why)];
  });
  return { refusal: `${skipped(packages.lacks.join('; '))}${notDownloaded.join('')}` };
}

async function trashedOrWhy({ adapter, trash }: RestoreDeps, folder: string, paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await adapter.trashFileIn(folder, path, trash);
    } catch (err) {
      return `'${path}' could not be moved to the trash: ${errorMessage(err)}`;
    }
  }
  return undefined;
}

// modlist-repository.md, Restore from manifest, story 9: the manifest's version and installation file, and what else the
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

// modlist-repository.md, The manifest, story 17: restore runs a mod's steps once its folder holds what its packages give.
async function whyNotStepped(pass: Pass, manifest: Manifest, folder: string): Promise<string | undefined> {
  if (manifest.steps.length === 0) return undefined;
  if (pass.options.signal?.aborted) return 'the restore was cancelled before its steps ran';
  const failed = await pass.deps.tasks.whyStepsFailed(manifest.steps.map(({ task, args }) => ({ task, args: [...args] })), folder);
  return failed === undefined ? undefined : `its ${failed}`;
}

// What follows its files: the files no line names to the trash, its metadata, then its steps.
async function whyNotFinished(pass: Pass, mod: string, manifest: Manifest, folder: string, namedByNoLine: readonly string[]): Promise<string | undefined> {
  return await trashedOrWhy(pass.deps, folder, namedByNoLine) ?? await metadataWrittenOrWhy(pass, mod, manifest) ?? await whyNotStepped(pass, manifest, folder);
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
async function restoreFromPackages(pass: Pass, mod: string, folder: string, manifest: Manifest, checksOutput: boolean): Promise<Answer> {
  const { adapter } = pass.deps;
  const { output } = manifest;
  if (checksOutput && output !== undefined && output.toLowerCase() !== basename(folder).toLowerCase()) {
    return { refusal: skipped(`its manifest names the output folder '${output}', not its folder '${basename(folder)}'`) };
  }
  const packages = await packagesFor(pass, manifest);
  if ('refusal' in packages) return packages;
  let against: FolderAgainst;
  try {
    against = await compared(adapter, manifest, folder, packages);
  } catch (err) {
    return { refusal: skipped(`a file could not be read: ${errorMessage(err)}`) };
  }
  const writes = against.lines.flatMap(({ line, onDisk, holdsItsBytes }) => {
    const from = packages.sources.get(line.path);
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

// modlist-repository.md, Restore from manifest, story 3: built only at the commit the instance repository pins.
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

// modlist-repository.md, Restore from manifest, story 5: what the build makes comes back as the build makes it.
async function rebuilt(pass: Pass, mod: string, folder: string, sourceFolder: string, manifest: Manifest, submodule: string): Promise<Answer> {
  const { adapter, client } = pass.deps;
  const cloned = await clonedAtThePin(pass, submodule);
  if ('refusal' in cloned) return cloned;
  const packages = await packagesFor(pass, manifest);
  if ('refusal' in packages) return packages;
  const before = await hashesIn(adapter, folder);
  const buildMod: BuildMod = {
    name: mod, sourceFolder, folder, metadataFiles: [...adapter.metadataFilesInModFolder], version: manifest.version ?? null, isSubmodule: true,
    installationFiles: packages.installationFiles.flatMap((file) => wireFile(file) ?? []),
  };
  const outcome = await client.build([buildMod], { ...pass.facts, gameFolder: wireGameFolder(pass.game, packages.gameFiles, false) });
  if (isRefused(outcome)) return { refusal: `was not built: ${outcome.message.replace(/\.$/, '')}.` };
  const [refused] = outcome.refused;
  if (refused !== undefined) return { refusal: refused.reason };
  const [built] = outcome.landed;
  const leftAsItWas = [...built?.failure === undefined ? [] : [built.failure], ...built?.refused.map(({ reason }) => reason) ?? [], ...built?.archivesRefused.map(({ reason }) => reason) ?? []];
  if (leftAsItWas.length > 0) return { refusal: `was not finished: ${leftAsItWas.map((why) => why.replace(/\.$/, '')).join('; ')}.` };
  const recorded = await manifestHeld(folder, sourceFolder);
  if (recorded === undefined || 'refusal' in recorded) return { refusal: notFinished(recorded?.refusal ?? 'its build wrote no manifest') };
  let after: Map<string, string>;
  let namedByNoLine: readonly string[];
  try {
    after = await hashesIn(adapter, folder);
    namedByNoLine = (await compared(adapter, recorded.manifest, folder, packages)).namedByNoLine;
  } catch (err) {
    return { refusal: notFinished(errorMessage(err)) };
  }
  const why = await whyNotFinished(pass, mod, recorded.manifest, folder, namedByNoLine);
  if (why !== undefined) return { refusal: notFinished(why) };
  return {
    landed: {
      mod, written: [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path).sort(), namedByNoLine,
      ...(built?.uncommitted ? { uncommitted: true } : {}), ...cloned,
    },
  };
}

async function restoreMod(pass: Pass, mod: string): Promise<Answer> {
  const folder = await pass.folders.of(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const sourceFolder = pass.sourceMods.folderOf(mod);
  const held = await manifestHeld(folder, sourceFolder);
  if (held === undefined) return { refusal: skipped('it has no manifest') };
  if ('refusal' in held) return held;
  const submodule = submoduleOf(held.manifest);
  if (sourceFolder !== undefined && submodule !== undefined) return rebuilt(pass, mod, folder, sourceFolder, held.manifest, submodule);
  const [first] = held.manifest.packages;
  if (first?.kind === 'sourceRepository' && !first.isSubmodule) return { refusal: skipped('its package has no host') };
  return restoreFromPackages(pass, mod, folder, held.manifest, sourceFolder === undefined);
}

const notCloned = (why: string): string => `was not cloned: ${why.replace(/\.$/, '')}.`;

// modlist-repository.md, Restore from manifest, story 3: a submodule the source folder lacks is cloned first, because the
// manifest it holds is what names the mod it builds.
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

// modlist-repository.md, Every mod, story 1: every other manifest, a source mod's whose folder its build has not made included.
const withEverySourceMod = (mods: readonly string[], sourceMods: SourceMods): string[] => {
  const listed = new Set(mods.map((mod) => mod.toLowerCase()));
  return [...mods, ...[...sourceMods.folders.keys()].filter((mod) => !listed.has(mod.toLowerCase()))];
};

// modlist-repository.md, The repository, story 6: a hook does not travel with a clone, so restore writes it as git init does.
async function pushRefusalWrittenOrWhy(adapter: Adapter): Promise<string | undefined> {
  try {
    if (await adapter.repositoryOnDisk()) await adapter.refuseUnpublishedPins();
  } catch (err) {
    return errorMessage(err);
  }
  return undefined;
}

// modlist-repository.md, The repository, story 4: a clone holds a path token where its game path is until restore puts
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
 *  so a source mod whose folder its build has not made joins them. */
export async function restoreFromManifest(
  deps: RestoreDeps, asked: readonly string[], options: Options, everyManifest: boolean, others: readonly OtherManifest[],
): Promise<RestoreResult> {
  const { adapter } = deps;
  const pathTokensNotWritten = await pathTokensWrittenOrWhy(adapter);
  const notClonedYet = await submodulesCloned(deps, options.onProgress);
  const sourceMods = await adapter.sourceMods();
  const ordered = await inModOrder(adapter, namesOf(everyManifest ? withEverySourceMod(asked, sourceMods) : asked, others));
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

// The listing asks before restore downloads anything, so it reads what the downloads folder holds now.
async function installationFilesHeld(adapter: Adapter, manifest: Manifest): Promise<PackageSources['downloaded']> {
  const read = new Map<string, Awaited<ReturnType<Adapter['downloadedFile']>>>();
  for (const pkg of manifest.packages) {
    if (pkg.kind === 'installationFile') read.set(pkg.name, await adapter.downloadedFile(pkg.name));
  }
  return (name) => read.get(name) ?? { kind: 'read', answer: undefined };
}

async function destroysIn(pass: Pass, mod: string): Promise<ModRestoreDestroys | { readonly refusal: string } | undefined> {
  const { adapter } = pass.deps;
  const folder = await pass.folders.of(mod);
  if (folder === undefined) return undefined;
  const metadata = pass.folders.isMod(mod) ? await adapter.modMetadata(mod) : undefined;
  if (metadata?.kind === 'unreadable') return { refusal: skipped(metadataUnreadable(metadata.reason)) };
  const held = await manifestHeld(folder, pass.sourceMods.folderOf(mod));
  if (held === undefined) return undefined;
  if ('refusal' in held) return held;
  const says = metadataOf(held.manifest);
  const unwritable = metadata === undefined ? undefined : await adapter.unwritableMetadata(mod, says);
  if (unwritable !== undefined) return { refusal: skipped(unwritable) };
  try {
    const downloaded = await installationFilesHeld(adapter, held.manifest);
    const against = await compared(adapter, held.manifest, folder, await packagesRead(adapter, held.manifest, { downloaded, game: pass.game, tasks: pass.tasks }));
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
  const sourceMods = await adapter.sourceMods();
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
