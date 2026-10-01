// MO2's parsed reads: each file read through its own codec, and each answer about where the
// instance keeps what.

import { basename, dirname } from 'node:path';
import { parsePlugins } from '../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../ports/errorMessage';
import { DOWNLOAD_SIDECAR_SUFFIX, parseDownloadMeta } from './codecs/downloads';
import { parseMetaIni } from './codecs/metaIni';
import { parseModlist } from './codecs/modlistText';
import { readGameName, readSelectedProfile } from './codecs/modOrganizerIni';
import { creationClubListFile, dataFolderOf, gameReleaseForGame } from '../tables/gamePaths';
import { factsOf, get, isTracked, listDir } from './files';
import {
  type DataFolderPlugins, type DownloadedFile, type DownloadedFiles, type GameFolder, type InstanceAdapter,
} from './instanceAdapter';
import {
  DATA_FOLDER_PLUGINS_GLOB, DOWNLOADS_WATCH_GLOB, downloadFile, downloadNameAt, downloadSidecarFile, isTempWrite, modDir, modlistFile,
  modMetaFile, pluginsFile, profilesDir, settingsFile,
} from './layout';
import { folderHolding, listedAs, listModFolders, modFoldersOf, readOrAbsent, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';
import { isPluginFile } from './pluginFile';

export type Mo2Reads = Omit<InstanceAdapter,
  | 'changeModOrder' | 'changePluginOrder' | 'createModFolder' | 'trashEntryFolder' | 'markDownloadedFile'
  | 'trashDownloadedFileMeta' | 'selectProfile' | 'extractedEntries'
  | 'extractNewMod' | 'extractUpgrade' | 'subscribe' | 'names'>;

async function listDownloadedFiles(downloadsDir: string): Promise<DownloadedFile[] | undefined> {
  const dirents = await readOrAbsent(() => listDir(downloadsDir), undefined);
  if (dirents === undefined) return undefined;
  const names = dirents
    .filter((d) => d.isFile() && !isTempWrite(d.name) && !d.name.endsWith(DOWNLOAD_SIDECAR_SUFFIX))
    .map((d) => d.name);
  return Promise.all(names.map(async (name) => {
    const path = downloadFile(downloadsDir, name);
    const metaPath = downloadSidecarFile(downloadsDir, name);
    const [facts, metaText] = await Promise.all([
      factsOf(path),
      readOrAbsent<string | undefined>(() => get(metaPath), undefined),
    ]);
    const meta = metaText === undefined ? undefined : parseDownloadMeta(metaText);
    return { name, path, metaPath, size: facts.size, mtimeMs: facts.mtimeMs, meta };
  }));
}

async function listGameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins> {
  const dataFolder = dataFolderOf(gameFolder);
  if (dataFolder === undefined) return { kind: 'unresolved' };
  try {
    const dirents = await listDir(dataFolder);
    return { kind: 'listed', names: new Set(dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => d.name.toLowerCase())) };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}

// The game writes its Creation Club list in plugins.txt's own line format.
async function readCreationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]> {
  const file = gameFolder.kind === 'found' ? creationClubListFile(gameFolder.root, gameRelease) : undefined;
  if (file === undefined) return [];
  const text = await readOrAbsent<string | undefined>(() => get(file), undefined);
  return text === undefined ? [] : parsePlugins(text).map((entry) => entry.name);
}

// The tables key each release on the game's name as `gameName=` spells it.
const gameOf = (gameName: string) => ({ gameName, gameRelease: gameReleaseForGame(gameName) });

export function mo2Reads(context: Mo2Context): Mo2Reads {
  const { instanceRoot, resolveGameFolder, resolveDownloadsFolder, watch } = context;
  return {
    async settings() {
      const iniText = await get(settingsFile(instanceRoot));
      const game = gameOf(readGameName(iniText));
      return {
        profile: readSelectedProfile(iniText),
        ...game,
        // What the settings resolve is what the watch follows.
        gameFolder: async () => {
          const gameFolder = await resolveGameFolder(iniText);
          watch.follow('gameFolderPlugins', dataFolderOf(gameFolder), DATA_FOLDER_PLUGINS_GLOB);
          const creationClubList = gameFolder.kind === 'found'
            ? creationClubListFile(gameFolder.root, game.gameRelease)
            : undefined;
          if (creationClubList === undefined) watch.follow('creationClubList', undefined, '');
          else watch.follow('creationClubList', dirname(creationClubList), basename(creationClubList));
          return gameFolder;
        },
        downloadedFiles: async (): Promise<DownloadedFiles> => {
          const resolution = await resolveDownloadsFolder(instanceRoot, iniText);
          watch.follow('downloadedFiles', resolution.kind === 'resolved' ? resolution.downloadsDir : undefined, DOWNLOADS_WATCH_GLOB);
          if (resolution.kind === 'unresolved') return resolution;
          const { downloadsDir } = resolution;
          return { kind: 'listed', downloadsDir, files: await listDownloadedFiles(downloadsDir) };
        },
      };
    },

    async profiles() {
      const dirents = await readOrAbsent(() => listDir(profilesDir(instanceRoot)), []);
      return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    },

    async modOrder(profile) {
      return parseModlist(await get(modlistFile(instanceRoot, profile)));
    },

    async orderEntry(profile, entry) {
      return listedAs(parseModlist(await get(modlistFile(instanceRoot, profile))), entry);
    },

    modMeta(mod) {
      return readOrAbsent(async () => parseMetaIni(await get(modMetaFile(instanceRoot, mod))), {});
    },

    modFolders: async (skippedLink) => {
      const all = await listModFolders(context, skippedLink);
      return all === undefined ? undefined : modFoldersOf(all);
    },

    async pluginOrder(profile) {
      return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
    },

    gameFolderPlugins: listGameFolderPlugins,

    creationClubList: readCreationClubList,

    async downloadedFileAt(path) {
      const resolution = await resolveDownloadsFolder(instanceRoot, await get(settingsFile(instanceRoot)));
      return resolution.kind === 'resolved' ? downloadNameAt(resolution.downloadsDir, path, process.platform) : undefined;
    },

    entryFolder: (entry) => folderHolding(context, entry),

    originFiles: (origin) => originFilesIn(instanceRoot, origin),

    modTracked: (mod) => isTracked(modDir(instanceRoot, mod)),
  };
}
