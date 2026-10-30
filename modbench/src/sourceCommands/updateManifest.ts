import { join } from 'node:path';
import type { InstallationFile, InstanceAdapter, OtherManifest, SourceMods } from '../instanceAdapter/instanceAdapter';
import { manifestIn, statusOf, writeManifestIn, type Manifest, type ModStatus } from '../manifestAdapter/manifestAdapter';
import type { FileProblems } from '../ports/fileProblems';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { foldersOf, namesOf, sourceFolderOf, type Folders } from './folders';
import { gameFilesOf, gameHeld, gameToHand, type GameToHand } from './gameFolderFacts';
import { buildManifest, downloadedFilesOf, type GameHeld, type HashedModFile, type PackageEntries } from './manifestBuilder';
import { metadataUnreadable } from './sourceCommands';

type Adapter = Pick<InstanceAdapter,
  'sourceMods' | 'modOrder' | 'gamePlaces' | 'gameRelease' | 'gameFiles' | 'gameFilesTakenBy' | 'modFolderPath' | 'installationFile' | 'modMetadata'
  | 'downloadedFilesHashed' | 'filesIn' | 'originFileHash' | 'fileStamp' | 'packageEntries' | 'textHash' | 'keepPackageEntries'
  | 'writeSubmodules' | 'writeOtherManifestLines' | 'keepOutOfPublisher' | 'pathsOutsideFolders'>;

export interface UpdateManifestDeps {
  readonly adapter: Adapter;
  readonly pathProblems: FileProblems;
  readonly instanceRoot: string;
}

/** What update manifest could not read of a mod, which a person or an agent reads by the mod's label. */
export interface ModNote { readonly mod: string; readonly note: string }

interface ModUpdated {
  readonly mod: string;
  readonly manifestWritten: boolean;
  readonly notInPackage: readonly string[];
  readonly otherBytes: readonly string[];
}

/** What update manifest answers. `cancelled`: the signal aborted, so the landed mods are those before it. `manifestWritten`
 *  is false when a manifest already was so; `notInPackage` and `otherBytes` name the files no package holds. */
export interface UpdateManifestResult {
  readonly cancelled?: true;
  readonly landed: readonly ModUpdated[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly notes: readonly ModNote[];
  readonly repositoryNotes: readonly string[];
}

/** Where update manifest is: reading a mod's installation file and game files, hashing downloaded files, or updating a mod. */
export type UpdateManifestStatus =
  | { readonly phase: 'ReadingFiles'; readonly mod: string }
  | { readonly phase: 'Hashing'; readonly left: number }
  | { readonly phase: 'Updating'; readonly mod: string; readonly modsDone: number; readonly modsTotal: number };

interface ModToUpdate {
  readonly name: string;
  readonly folder: string;
  readonly installationFile?: InstallationFile;
  readonly sourceFolder?: string;
  readonly version?: string;
  readonly game?: GameHeld;
}

interface UpdateOptions {
  readonly onProgress?: (status: UpdateManifestStatus) => void;
  readonly signal?: AbortSignal;
}

async function readMod(
  adapter: Adapter, mod: string, folders: Folders, game: GameToHand, sourceMods: SourceMods,
): Promise<{ read: Omit<ModToUpdate, 'version'>; notes: readonly string[] } | { refusal: string }> {
  const folder = await folders.of(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  if (!folders.isMod(mod)) {
    const taken = await gameFilesOf(adapter, { mod, folder }, game, false);
    if ('refusal' in taken) return taken;
    return { read: { name: mod, folder, ...withGame(game, taken.gameFiles) }, notes: taken.notes };
  }
  const installed = await adapter.installationFile(mod);
  if (installed.kind === 'unreadable') return { refusal: installed.reason };
  const taken = await gameFilesOf(adapter, { mod, folder }, game, installed.answer !== undefined);
  if ('refusal' in taken) return taken;
  return {
    read: {
      name: mod, folder, ...withGame(game, taken.gameFiles), ...sourceFolderOf(sourceMods, mod),
      ...installed.answer === undefined ? {} : { installationFile: installed.answer },
    },
    notes: [
      ...taken.notes,
      ...installed.answer?.unpagedGame === undefined
        ? []
        : [`its installation file comes from '${installed.answer.unpagedGame}', a game whose host the instance adapter has no page on, so its manifest names no page`],
    ],
  };
}

const withGame = (game: GameToHand, held: Parameters<typeof gameHeld>[1]): { game?: GameHeld } => {
  const places = gameHeld(game.folder, held);
  return places === undefined ? {} : { game: places };
};

const takesFromTheGame = (mod: Pick<ModToUpdate, 'game'>): boolean => mod.game?.places.some((place) => place.files.length > 0) === true;

const depotProblemsOf = (game: GameToHand, mods: readonly ModToUpdate[]): readonly string[] =>
  (typeof game.folder === 'string' || !mods.some(takesFromTheGame) ? [] : game.folder.places.flatMap((place) => place.depotProblems));

type Answer = { readonly refusal: string } | { readonly landed: ModUpdated; readonly notes: readonly string[] };

const refusal = (why: string): { refusal: string } => ({ refusal: `was not updated: ${why}` });

const pathsWhere = (manifest: Manifest, kind: 'notHeld' | 'otherBytes'): string[] =>
  manifest.files.filter((file) => file.entry.kind === kind).map((file) => file.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ADR-0022: a source mod's build writes its manifest.
async function leftToItsBuild(adapter: Adapter, mod: ModToUpdate & { sourceFolder: string }): Promise<Answer> {
  const status: ModStatus = await statusOf({ name: mod.name, folder: mod.folder, sourceFolder: mod.sourceFolder }, adapter);
  if (status.unreadable !== undefined) return refusal(`${status.unreadable}.`);
  if (status.noManifest) return refusal('its build writes its manifest, and it has not written one.');
  if (status.differing.length + status.namedByNoLine.length + status.gone.length > 0) {
    return refusal('its build writes its manifest, and its folder differs from what the build wrote.');
  }
  return { landed: { mod: mod.name, manifestWritten: false, notInPackage: status.notInPackage, otherBytes: status.otherBytes }, notes: [] };
}

async function folderMissing(adapter: Adapter, folder: string): Promise<boolean> {
  const stamp = await adapter.fileStamp(folder);
  return stamp.kind === 'unreadable' && stamp.reason.includes('ENOENT');
}

type Hashed = { readonly files: readonly HashedModFile[] } | { readonly unreadable: string };

async function hashedFilesOf(adapter: Adapter, folder: string, madeByStep: ReadonlySet<string>): Promise<Hashed> {
  const files: HashedModFile[] = [];
  for (const path of await adapter.filesIn(folder)) {
    if (madeByStep.has(path)) continue;
    const read = await adapter.originFileHash(join(folder, path));
    if (read.kind === 'unreadable') return { unreadable: read.reason };
    files.push({ path, hash: read.answer.hash });
  }
  return { files };
}

async function heldManifestOf(folder: string): Promise<Manifest | undefined | { readonly refusal: string }> {
  try {
    const held = await manifestIn(folder);
    if (held === undefined) return undefined;
    return 'refused' in held ? refusal(`${held.refused}.`) : held.manifest;
  } catch (err) {
    return refusal(`its manifest could not be read: ${errorMessage(err)}`);
  }
}

async function packageEntriesKept(adapter: Adapter, gamePackage: PackageEntries | undefined): Promise<readonly string[]> {
  if (gamePackage === undefined) return [];
  const why = await adapter.keepPackageEntries(gamePackage.hash, gamePackage.entries);
  return why === undefined ? [] : [`the files it takes from the game folder could not be recorded, so its status reads them as differing: ${why}`];
}

async function updateMod(adapter: Adapter, mod: ModToUpdate, downloadedFiles: ReturnType<typeof downloadedFilesOf>): Promise<Answer> {
  if (mod.sourceFolder !== undefined) return leftToItsBuild(adapter, { ...mod, sourceFolder: mod.sourceFolder });

  const held = await heldManifestOf(mod.folder);
  if (held !== undefined && 'refusal' in held) return held;
  if (mod.game === undefined && held?.packages.some((pkg) => pkg.kind === 'gameFolder')) {
    return refusal('its manifest names the game folder, and the game folder was not found.');
  }
  if (await folderMissing(adapter, mod.folder)) return refusal('its folder does not exist.');

  const madeByStep = new Set(held?.files.filter((line) => line.entry.kind === 'madeByStep').map((line) => line.path));
  let hashed: Hashed;
  try {
    hashed = await hashedFilesOf(adapter, mod.folder, madeByStep);
  } catch (err) {
    hashed = { unreadable: errorMessage(err) };
  }
  if ('unreadable' in hashed) return refusal(`a file could not be read: ${hashed.unreadable}`);

  const { manifest, gamePackage } = await buildManifest(
    { downloadedFiles, ...mod.game === undefined ? {} : { game: mod.game }, ...mod.installationFile === undefined ? {} : { installationFile: mod.installationFile } },
    hashed.files, mod.version, held, (text) => adapter.textHash(text));
  let written: boolean;
  try {
    written = await writeManifestIn(mod.folder, manifest);
  } catch (err) {
    return refusal(`its manifest could not be written: ${errorMessage(err)}`);
  }
  return {
    landed: { mod: mod.name, manifestWritten: written, notInPackage: pathsWhere(manifest, 'notHeld'), otherBytes: pathsWhere(manifest, 'otherBytes') },
    notes: await packageEntriesKept(adapter, gamePackage),
  };
}

// publishing.md, What ships, story 1
async function keptOutOfPublisher(adapter: Adapter): Promise<readonly string[]> {
  try {
    await adapter.keepOutOfPublisher();
    return [];
  } catch (err) {
    return [errorMessage(err)];
  }
}

// modlist-repository.md, The repository, story 2: git cannot let in a file inside a folder its ignore list leaves out.
async function otherManifestLinesWritten(adapter: Adapter): Promise<readonly string[]> {
  try {
    await adapter.writeOtherManifestLines();
    return [];
  } catch (err) {
    return [errorMessage(err)];
  }
}

async function submodulesWritten(adapter: Adapter, acted: readonly string[] | 'every'): Promise<{ notes: readonly ModNote[]; repositoryNotes: readonly string[] }> {
  try {
    const { notes, other } = await adapter.writeSubmodules(acted);
    return { notes, repositoryNotes: other };
  } catch (err) {
    return { notes: [], repositoryNotes: [errorMessage(err)] };
  }
}

async function pathsShown({ adapter, pathProblems, instanceRoot }: UpdateManifestDeps): Promise<readonly string[]> {
  try {
    const found = await adapter.pathsOutsideFolders();
    pathProblems.clearAll();
    for (const file of new Set(found.map((path) => path.file))) {
      pathProblems.set(join(instanceRoot, file), found.filter((path) => path.file === file).map(({ line, path }) => ({ line, message: `holds a path no path token names: ${path}` })));
    }
    return [];
  } catch (err) {
    return [`the paths the instance repository's files hold could not be read: ${errorMessage(err)}`];
  }
}

const cancelledIf = (signal: AbortSignal | undefined): { cancelled?: true } => (signal?.aborted ? { cancelled: true } : {});

/** Each mod's manifest from the mod as it is. A mod the Instance adapter cannot answer is refused, naming why. `everyMod`:
 *  a source mod that is gone loses its submodule entry. */
export async function updateManifest(
  deps: UpdateManifestDeps, mods: readonly string[], { onProgress, signal }: UpdateOptions, others: readonly OtherManifest[], everyMod: boolean,
): Promise<UpdateManifestResult> {
  const { adapter } = deps;
  const sourceMods = await adapter.sourceMods();
  const game = await gameToHand(adapter, sourceMods);
  const folders = foldersOf(adapter, others);
  const refused: ItemRefusal<string>[] = [];
  const notes: ModNote[] = [];
  const read: Omit<ModToUpdate, 'version'>[] = [];
  for (const mod of new Set(namesOf(mods, others))) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'ReadingFiles', mod });
    const answer = await readMod(adapter, mod, folders, game, sourceMods);
    if ('refusal' in answer) { refused.push({ item: mod, reason: answer.refusal }); continue; }
    read.push(answer.read);
    notes.push(...answer.notes.map((note) => ({ mod, note })));
  }
  const nothingUpdated = async (): Promise<UpdateManifestResult> => ({
    ...cancelledIf(signal), landed: [], refused, notes, repositoryNotes: await pathsShown(deps),
  });
  if (signal?.aborted || read.length === 0) return nothingUpdated();

  const versioned: ModToUpdate[] = [];
  for (const mod of read) {
    if (!folders.isMod(mod.name)) { versioned.push(mod); continue; }
    const metadata = await adapter.modMetadata(mod.name);
    if (metadata.kind === 'unreadable') refused.push({ item: mod.name, reason: metadataUnreadable(metadata.reason) });
    else versioned.push(metadata.answer.version === undefined ? mod : { ...mod, version: metadata.answer.version });
  }
  if (versioned.length === 0) return nothingUpdated();

  const downloaded = await adapter.downloadedFilesHashed({ onHashing: (left) => onProgress?.({ phase: 'Hashing', left }), signal });
  if (signal?.aborted) return nothingUpdated();

  const downloadedFiles = downloadedFilesOf(downloaded.files);
  const landed: ModUpdated[] = [];
  const acted: string[] = [];
  for (const [at, mod] of versioned.entries()) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'Updating', mod: mod.name, modsDone: at, modsTotal: versioned.length });
    const answer = await updateMod(adapter, mod, downloadedFiles);
    acted.push(mod.name);
    if ('refusal' in answer) { refused.push({ item: mod.name, reason: answer.refusal }); continue; }
    landed.push(answer.landed);
    notes.push(...answer.notes.map((note) => ({ mod: mod.name, note })));
  }
  const submodules = await submodulesWritten(adapter, everyMod ? 'every' : acted);
  return {
    ...cancelledIf(signal), landed, refused, notes: [...notes, ...submodules.notes],
    repositoryNotes: [
      ...downloaded.notes, ...depotProblemsOf(game, versioned), ...submodules.repositoryNotes,
      ...await otherManifestLinesWritten(adapter), ...await keptOutOfPublisher(adapter), ...await pathsShown(deps),
    ],
  };
}
