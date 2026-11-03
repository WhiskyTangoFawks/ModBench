// commands.md, version in git: a repository holding the mod's plugin source, a build file, and as its assets only the
// files no package yields with their bytes (ADR-0016).

import { basename, join } from 'node:path';
import { isRefused, type SourceFolderRequest, type SourceModIn, type WriteRefused } from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import {
  buildFileText, exclusionsOfFiles, isUnderAny, manifestIn, manifestNameOf, manifestText, ownFilesOf, sourceModsOf, writeManifestIn, type BuildStep, type Manifest,
} from '../manifestAdapter/manifestAdapter';
import { BUILD_FILE, PLUGIN_SOURCE_FOLDER } from '../wire/sourceMod';
import { errorMessage } from '../ports/errorMessage';
import type { MoveToTrash } from '../ports/trash';
import { pluginCompanionRule } from '../tables/gamePaths';
import { isPluginAtRoot } from '../tables/pluginFile';
import { heldManifestIn } from './heldManifest';
import { gameFilesOf, gameHeld, gameToHand, NONE_HELD, type GameToHand } from './gameFolderFacts';
import { sourceFolderRestoredFrom, type FolderRestoreAdapter, type RestoreDeps } from './restoreFromManifest';
import { buildManifest, downloadedFileOf, downloadedFilesOf, nexusFileOf, describedBy, type DownloadedFile, type GameHeld, type HashedModFile } from './manifestBuilder';

type Adapter = Pick<InstanceAdapter,
  'sourceFolder' | 'installationFile' | 'downloadedFile' | 'downloadedFilesHashed' | 'modFolderPath' | 'metadataFilesInModFolder' | 'filesIn' | 'originFileHash' | 'textHash' | 'nexusFileAt'
  | 'gameRelease' | 'gamePlaces' | 'modOrder' | 'gameFiles' | 'gameFilesTakenBy' | 'sourceModFolders' | 'entryKey' | 'folderValue' | 'repositoryOnDisk' | 'writeSourceModLines'>
  & FolderRestoreAdapter;

/** The source folder version in git makes for a mod, and the repository that holds it. */
export interface MadeSourceFolder {
  readonly modFolder: string;
  readonly sourceFolder: SourceFolderRequest;
  readonly notes: readonly string[];
}

function pluginsAndTheirStringsFiles(paths: readonly string[], gameRelease: string): Set<string> {
  const plugins = paths.filter(isPluginAtRoot);
  const rule = pluginCompanionRule(gameRelease);
  return new Set([...plugins, ...paths.filter((path) => plugins.some((plugin) => rule?.isStringsFileOf(plugin, path) === true))]);
}

async function hashed(adapter: Pick<Adapter, 'originFileHash'>, folder: string, paths: readonly string[]): Promise<HashedModFile[] | { readonly refusal: string }> {
  const files: HashedModFile[] = [];
  for (const path of paths) {
    const read = await adapter.originFileHash(join(folder, path));
    if (read.kind === 'unreadable') return { refusal: `a file of its folder could not be read: ${read.reason}` };
    files.push({ path, hash: read.answer.hash });
  }
  return files;
}

interface ModRead {
  readonly sourceFolder: string;
  readonly folder: string;
  readonly installationFile: InstallationFile | undefined;
  readonly game: GameHeld | undefined;
  readonly held: Manifest | undefined;
}

// A mod whose files cannot be read whole is refused, naming why.
async function modRead(adapter: Adapter, mod: string, game: GameToHand): Promise<ModRead | { readonly refusal: string }> {
  const sourceFolder = adapter.sourceFolder(mod);
  if (sourceFolder === undefined) return { refusal: 'its name gives it no source folder' };
  const installation = await adapter.installationFile(mod);
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const taken = typeof game.folder === 'string' ? { gameFiles: NONE_HELD, notes: [] } : await gameFilesOf(adapter, { mod, folder }, game, false);
  if ('refusal' in taken) return taken;
  if (taken.notes.length > 0) return { refusal: taken.notes.join('; ') };
  const held = await heldManifestIn(folder);
  if (held !== undefined && 'why' in held) return { refusal: held.why };
  if (typeof game.folder === 'string' && held?.packages.some(({ kind }) => kind === 'gameFolder')) {
    return { refusal: 'its manifest names the game folder, and the game folder was not found' };
  }
  return { sourceFolder, folder, installationFile: installation.kind === 'read' ? installation.answer : undefined, game: gameHeld(game.folder, taken.gameFiles), held };
}

async function downloadedRow(adapter: Pick<Adapter, 'downloadedFile'>, file: InstallationFile): Promise<InstallationFile | undefined> {
  const row = await adapter.downloadedFile(basename(file.path));
  return row.kind === 'read' ? row.answer : undefined;
}

// Every downloaded file as a package, and why any could not be read whole; asked once for a selection of mods.
async function downloadedPackagesOf(
  adapter: Pick<Adapter, 'downloadedFilesHashed' | 'nexusFileAt'>,
): Promise<{ readonly files: readonly DownloadedFile[]; readonly notes: readonly string[] }> {
  const { files, notes } = await adapter.downloadedFilesHashed();
  return { files: downloadedFilesOf(files, nexusFileOf(adapter)), notes };
}

// The source folder for `mod`: a manifest of what its packages give, its assets, and a build file that builds its folder back.
async function sourceFolderOf(
  adapter: Adapter, mod: string, game: GameToHand, downloadedFiles: readonly DownloadedFile[], heldIn: SourceModIn,
): Promise<MadeSourceFolder | { readonly refusal: string }> {
  const read = await modRead(adapter, mod, game);
  if ('refusal' in read) return read;
  const { sourceFolder, folder, held } = read;
  const installationFile = read.installationFile === undefined ? undefined : describedBy(read.installationFile, await downloadedRow(adapter, read.installationFile));
  const ignore = held?.ignore ?? [];
  const all = await hashed(adapter, folder, notMetadata(adapter, await adapter.filesIn(folder)).filter((path) => !isUnderAny(ignore, path)));
  if ('refusal' in all) return all;
  const compiled = pluginsAndTheirStringsFiles(all.map(({ path }) => path), await adapter.gameRelease());
  const own = installationFile === undefined ? undefined : downloadedFileOf(installationFile, nexusFileOf(adapter));
  const recorded = buildManifest(
    { downloadedFiles, ...own === undefined ? {} : { installationFile: own }, ...read.game === undefined ? {} : { game: read.game } },
    all.filter(({ path }) => !compiled.has(path)), [], held);
  const notAssets = new Set([...recorded.sources.keys(), ...compiled]);
  const sourceManifest: Manifest = { packages: recorded.manifest.packages, exclude: [], ignore: [], flags: new Map(), files: new Map([...recorded.manifest.files].filter(([path]) => recorded.sources.has(path))) };
  const copied = [...new Set(all.map(({ path }) => path).filter((path) => !compiled.has(path)).map((path) => path.split('/')[0] ?? path))].sort();
  const taken = takenBySourceFolder(copied, manifestNameOf(sourceFolder));
  if (taken !== undefined) return { refusal: taken };
  const plugins = [...compiled].filter(isPluginAtRoot).sort();
  const steps: BuildStep[] = [
    ...copied.length === 0 ? [] : [{ kind: 'copy' as const, paths: copied }],
    ...plugins.length === 0 ? [] : [{ kind: 'compile' as const, paths: plugins }],
  ];
  return {
    modFolder: folder,
    notes: recorded.notes,
    sourceFolder: {
      path: sourceFolder, in: heldIn, assets: all.filter(({ path }) => !notAssets.has(path)).map(({ path }) => path), buildFile: buildFileText({ steps }),
      manifestFile: manifestNameOf(sourceFolder), manifest: manifestText(sourceManifest), ignored: [...sourceManifest.files.keys()],
    },
  };
}

// A source folder holds the mod's files at their own paths, beside its own (wire/sourceMod.ts).
function takenBySourceFolder(entries: readonly string[], manifestFile: string): string | undefined {
  const own = [BUILD_FILE, PLUGIN_SOURCE_FOLDER, '.gitignore', '.gitattributes', '.git', manifestFile];
  const taken = entries.find((entry) => own.some((name) => name.toLowerCase() === entry.toLowerCase()));
  return taken === undefined ? undefined : `its '${taken}' is where its source folder holds its own`;
}

const notMetadata = (adapter: Pick<Adapter, 'metadataFilesInModFolder'>, paths: readonly string[]): string[] => {
  const leftOut = new Set(adapter.metadataFilesInModFolder.map((path) => path.toLowerCase()));
  return paths.filter((path) => !leftOut.has(path.toLowerCase()));
};

type LinkAdapter = Pick<Adapter, 'modFolderPath' | 'metadataFilesInModFolder' | 'folderValue'> & FolderRestoreAdapter;

// The source folder is new, and the installation file a mod was made from is on this machine.
const replacesNothing: MoveToTrash = (path) => Promise.reject(new Error(`'${path}' is in the source folder already`));
const downloadsNothing: RestoreDeps['nexus'] = { download: () => Promise.resolve({ found: false, reason: 'version in git downloads nothing' }) };

// The mod is a source mod once its folder's manifest names its repository, recording the folder as its build would.
// ADR-0022: the source folder's manifest writes what a package yields.
async function folderLinkedOrWhy(adapter: LinkAdapter, mod: string, { sourceFolder: made }: MadeSourceFolder): Promise<string | undefined> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return 'its name gives it no folder for a manifest that names its repository';
  try {
    const value = await adapter.folderValue(folder);
    const leftOut = new Set(adapter.metadataFilesInModFolder.map((path) => path.toLowerCase()));
    const held = await manifestIn(folder);
    const ignore = held !== undefined && 'manifest' in held ? held.manifest.ignore : [];
    const files = ownFilesOf({ files: new Map([...value.files].filter(([pathInFolder]) => !leftOut.has(pathInFolder.toLowerCase()))) }, ignore);
    if ('why' in files) return files.why;
    const manifest: Manifest = {
      packages: [{ kind: 'repository', name: basename(made.path) }], exclude: exclusionsOfFiles(value.exclude, files.keys()), ignore, flags: new Map(), files,
    };
    const notRestored = await sourceFolderRestoredFrom({ adapter, nexus: downloadsNothing, trash: replacesNothing }, mod, made.path, { folder, manifest });
    if (notRestored !== undefined) return `its source folder could not be restored from its manifest: ${notRestored}`;
    await writeManifestIn(folder, manifest);
    return undefined;
  } catch (err) {
    return `its manifest could not name its repository: ${errorMessage(err)}`;
  }
}

async function foldersNotLinked(
  adapter: LinkAdapter, made: ReadonlyMap<string, MadeSourceFolder>, committed: readonly string[],
): Promise<Map<string, string>> {
  const notLinked = new Map<string, string>();
  for (const mod of committed) {
    const folder = made.get(mod);
    const why = folder === undefined ? undefined : await folderLinkedOrWhy(adapter, mod, folder);
    if (why !== undefined) notLinked.set(mod, why);
  }
  return notLinked;
}

export const NO_INSTANCE_REPOSITORY = 'The instance holds no repository to put a mod in: git init makes one.';

/** What placing mods did, each answer by the mod it concerns: no source folder made or held, or a landed mod not linked
 *  or not left out of the instance repository. `notes` is what a downloaded file could not give. */
export interface PlacedMods<R> {
  readonly outcome: R | WriteRefused;
  readonly notMade: ReadonlyMap<string, string>;
  readonly notLinked: ReadonlyMap<string, string>;
  readonly notes: readonly string[];
}

// A repository of its own would show in the instance repository as a nested one.
async function leftOutOrWhy(adapter: Pick<Adapter, 'writeSourceModLines'>): Promise<string | undefined> {
  return adapter.writeSourceModLines().then(
    () => undefined, (err: unknown) => `the instance repository's ignore list could not leave its repository out: ${errorMessage(err)}`);
}

interface PlaceRequest {
  readonly mods: readonly string[];
  readonly where?: SourceModIn;
  readonly onProgress?: (mod: string, modsDone: number, modsTotal: number) => void;
}

/** The flow of version in git and decompile and repair: a source folder per mod. One in a new repository is left out of
 *  the instance repository once it lands. */
export async function modsPlaced<R>(
  adapter: Adapter, { mods, where, onProgress }: PlaceRequest,
  run: (made: ReadonlyMap<string, MadeSourceFolder>) => Promise<R | WriteRefused>, landedBy: (outcome: R) => Iterable<string>,
): Promise<PlacedMods<R> | WriteRefused> {
  if (where === 'InstanceRepository' && !(await adapter.repositoryOnDisk())) return { refused: true, message: NO_INSTANCE_REPOSITORY };
  const made = new Map<string, MadeSourceFolder>();
  const notMade = new Map<string, string>();
  let notes: readonly string[] = [];
  if (mods.length > 0) {
    if (where === undefined) return { refused: true, message: 'A mod to put under git needs where it is held.' };
    const game = await gameToHand(adapter, await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name })));
    const downloaded = await downloadedPackagesOf(adapter);
    notes = downloaded.notes;
    for (const [at, mod] of mods.entries()) {
      onProgress?.(mod, at, mods.length);
      const decided = await sourceFolderOf(adapter, mod, game, downloaded.files, where);
      if ('refusal' in decided) notMade.set(mod, decided.refusal);
      else {
        made.set(mod, decided);
        notes = [...notes, ...decided.notes.map((note) => `${mod}: ${note}`)];
      }
    }
  }
  const outcome = await run(made);
  const landed = [...new Set(isRefused(outcome) ? [] : landedBy(outcome))];
  const unfinished = await foldersNotLinked(adapter, made, landed);
  const notLeftOut = where === 'NewRepository' && landed.length > 0 ? await leftOutOrWhy(adapter) : undefined;
  if (notLeftOut !== undefined) {
    for (const mod of landed) {
      const why = unfinished.get(mod);
      unfinished.set(mod, why === undefined ? notLeftOut : `${why}; ${notLeftOut}`);
    }
  }
  return { outcome, notMade, notLinked: unfinished, notes };
}

/** `modsPlaced` bound to one instance, as decompile and repair is handed it. */
export const placeModsOver = (adapter: Adapter) =>
  <R>(request: PlaceRequest, run: (made: ReadonlyMap<string, MadeSourceFolder>) => Promise<R | WriteRefused>, landedBy: (outcome: R) => Iterable<string>) =>
    modsPlaced(adapter, request, run, landedBy);
