// MO2's parsed reads: each file read through its own codec, and each answer about where the
// instance keeps what.

import { basename, dirname } from 'node:path';
import { foldersRefused } from '../foldersRefused';
import { parsePlugins } from '../../loadOrderFileCodec/pluginsText';
import { isInstallationFileName } from '../downloadedFileContents/installationFileNames';
import { effectiveModId } from './codecs/nexusFileName';
import { METADATA_FILE_SUFFIX, parseDownloadedFileMeta } from './codecs/downloads';
import { type MetaIni, modMetaOf, parseMetaIni } from './codecs/metaIni';
import { entryNamed, MODLIST_FILE_NAME, modLineKey, parseModlist } from './codecs/modlistText';
import { readGamePath, readSelectedProfile, SETTINGS_FILE_NAME } from './codecs/modOrganizerIni';
import { gameOfSettings } from './mo2Game';
import type { ManagerGamePath } from '../gameFolder/gameFolderResolver';
import { creationClubFileOf, dataFolderOf, listDataFolderPlugins, readCreationClubList } from '../gameFolder/dataFolder';
import { pathTokensWritten } from './mo2PathTokens';
import { pushRefusalWritten } from './mo2Submodules';
import { factsOf, get, ignoreSkippedLink, isRepository, listEntries, listFolders, readOrAbsent, readOrReason, identityOf, type SkippedLink, stampOf, isOwnTemp } from '../files';
import type { DownloadedFile, DownloadedFiles, InstanceAdapter, ManagerNames, ManagerRunning, ModFolder, ModFolders } from '../instanceAdapter';
import { DATA_FOLDER_PLUGINS_GLOB, DOWNLOADS_WATCH_GLOB, downloadedFilePath, downloadedFileMetadataPath, modlistFile, modMetaFileIn, modSourceDir, pluginsFile, profilesDir, settingsFile } from './layout';
import { mo2Archives } from './mo2Archives';
import type { ReadingSource } from '../instanceReading';
import type { ConfigurationFile } from '../publisher';
import { entryKey, listModFolders, modFolderNamed, modFoldersOf, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';
import { sourceModsIn } from './sourceMods';
import { errorMessage } from '../../ports/errorMessage';
import { holdsPathToken } from '../pathTokens';

async function listDownloadedFiles(downloadsDir: string, skippedLink: SkippedLink): Promise<DownloadedFile[] | undefined> {
  const dirents = await readOrAbsent(() => listEntries(downloadsDir, skippedLink), undefined);
  if (dirents === undefined) return undefined;
  const names = dirents
    .filter((d) => d.isFile && isInstallationFileName(d.name) && !isOwnTemp(d.name))
    .map((d) => d.name);
  return Promise.all(names.map(async (name) => {
    const path = downloadedFilePath(downloadsDir, name);
    const metadataPath = downloadedFileMetadataPath(downloadsDir, name);
    const [facts, metaText] = await Promise.all([
      factsOf(path),
      readOrAbsent<string | undefined>(() => get(metadataPath), undefined),
    ]);
    const parsed = metaText === undefined ? undefined : parseDownloadedFileMeta(metaText);
    return { name, path, metadataPath, size: facts.size, mtimeMs: facts.mtimeMs, excluded: parsed?.hidden ?? false, meta: parsed?.meta, modID: effectiveModId(parsed?.meta.modID, name) };
  }));
}

const GAME_PATH_PLACE = `${SETTINGS_FILE_NAME}'s gamePath`;

// A clone's game path is a path token until the game folder is found elsewhere.
function gamePathOf(iniText: string): string | undefined {
  try {
    const path = readGamePath(iniText);
    return holdsPathToken(path) ? undefined : path;
  } catch {
    return undefined;
  }
}

const MO2_NAMES: ManagerNames = { manager: 'MO2', modOrderFile: MODLIST_FILE_NAME, downloadedFileMetadataFile: METADATA_FILE_SUFFIX };

/** A mod's meta.ini as it reads, `{}` for a separator, a mod with no folder and a meta that is gone. */
export async function readMetaIni(context: Mo2Context, mod: string, folders: ModFolders | undefined | 'list'): Promise<MetaIni> {
  if (entryNamed(mod).kind === 'separator') return {};
  const folder = await modFolderNamed(context, mod, folders);
  return folder === undefined ? {} : readOrAbsent(async () => parseMetaIni(await get(modMetaFileIn(folder))), {});
}

export function readingSource(context: Mo2Context, publisherFile: ConfigurationFile | undefined): ReadingSource {
  const { instanceRoot, resolveGameFolder, resolveDownloadsFolder, watch, mo2Running } = context;
  return {
    names: MO2_NAMES,
    modLineKey,
    ...mo2Archives(context),
    async settings() {
      const iniText = await get(settingsFile(instanceRoot));
      const game = gameOfSettings(iniText);
      return {
        profile: readSelectedProfile(iniText),
        ...game,
        // What the settings resolve is what the watch follows.
        gameFolder: async () => {
          const managed: ManagerGamePath = { path: gamePathOf(iniText), place: GAME_PATH_PLACE, release: game.gameRelease };
          const gameFolder = await resolveGameFolder(managed);
          watch.follow('gameFolderPlugins', dataFolderOf(gameFolder), DATA_FOLDER_PLUGINS_GLOB);
          const creationClubList = creationClubFileOf(gameFolder, game.gameRelease);
          if (creationClubList === undefined) watch.follow('creationClubList', undefined, '');
          else watch.follow('creationClubList', dirname(creationClubList), basename(creationClubList));
          return gameFolder;
        },
        downloadedFiles: async (skippedLink: SkippedLink): Promise<DownloadedFiles> => {
          const resolution = await resolveDownloadsFolder(instanceRoot, iniText);
          watch.follow('downloadedFiles', resolution.kind === 'resolved' ? resolution.downloadsDir : undefined, DOWNLOADS_WATCH_GLOB);
          if (resolution.kind === 'unresolved') return resolution;
          const { downloadsDir } = resolution;
          return { kind: 'listed', downloadsDir, files: await listDownloadedFiles(downloadsDir, skippedLink) };
        },
      };
    },

    async profiles(skippedLink) {
      return readOrAbsent(() => listFolders(profilesDir(instanceRoot), skippedLink), []);
    },

    async modOrder(profile) {
      return parseModlist(await get(modlistFile(instanceRoot, profile)));
    },

    modMeta: async (mod, folders) => modMetaOf(await readMetaIni(context, mod, folders)),

    modFolders: async (skippedLink) => {
      const all = await listModFolders(context, skippedLink);
      return all === undefined ? undefined : modFoldersOf(all);
    },

    async pluginOrder(profile) {
      return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
    },

    gameFolderPlugins: listDataFolderPlugins,

    creationClubList: readCreationClubList,

    originFiles: (origin, folders) => originFilesIn(context, origin, false, folders),

    originRootFiles: (origin, folders) => originFilesIn(context, origin, true, folders),

    sourceMods: () => sourceModsIn(instanceRoot),

    holdsRepository: () => isRepository(instanceRoot),
    repositorySetUp: async () => await isRepository(instanceRoot) && await pushRefusalWritten(instanceRoot) && await pathTokensWritten(instanceRoot, publisherFile),
    watchNotes: () => watch.watchNotes(),
    managerRunning: () => mo2Running().then(
      (running): ManagerRunning => ({ kind: running ? 'running' : 'notRunning' }),
      (err: unknown): ManagerRunning => ({ kind: 'unknown', reason: errorMessage(err) }),
    ),
  };
}

const indexedListings = new WeakMap<readonly ModFolder[], ModFolders>();
const indexed = (listing: readonly ModFolder[]): ModFolders => {
  const held = indexedListings.get(listing) ?? modFoldersOf(listing);
  indexedListings.set(listing, held);
  return held;
};

export function mo2Reads(
  context: Mo2Context, source: ReadingSource,
): Pick<InstanceAdapter, 'modFolderPath' | 'foldersRefused' | 'sourceFolder' | 'fileStamp' | 'entryKey' | 'profiles' | 'modOrder' | 'downloadedFiles' | 'downloadedFileAt' | 'sourceMods'> {
  const { instanceRoot } = context;
  const reads: ReturnType<typeof mo2Reads> = {
    profiles: () => source.profiles(ignoreSkippedLink),
    downloadedFiles: async () => (await source.settings()).downloadedFiles(ignoreSkippedLink),
    downloadedFileAt: (path) => readOrReason(async () => {
      const listed = await reads.downloadedFiles();
      if (listed.kind !== 'listed') throw new Error(listed.reason);
      const files = listed.files ?? [];
      const exact = files.find((file) => file.path === path);
      if (exact !== undefined) return exact;
      const target = await identityOf(path);
      if (target === undefined) return undefined;
      for (const file of files) {
        if (await identityOf(file.path) === target) return file;
      }
      return undefined;
    }),
    modOrder: async () => ({ mods: await source.modOrder((await source.settings()).profile), modFolders: await listModFolders(context, ignoreSkippedLink) }),
    sourceMods: () => source.sourceMods(),
    modFolderPath: (name, among) => modFolderNamed(context, name, among === undefined ? 'list' : indexed(among)),
    foldersRefused: (folders, asked) => foldersRefused(instanceRoot, folders, asked),
    sourceFolder: (mod) => modSourceDir(instanceRoot, mod),
    entryKey,
    fileStamp: (path) => readOrReason(() => stampOf(path)),
  };
  return reads;
}

