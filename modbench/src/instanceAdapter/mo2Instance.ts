// MO2's implementation of the Instance adapter: each file read or spliced through its own codec
// and written whole.

import {
  appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText,
} from '../loadOrderFileCodec/pluginsText';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import {
  DOWNLOAD_SIDECAR_SUFFIX, parseDownloadMeta, setHiddenInText, setInstalledInText, setUninstalledInText,
} from './codecs/downloads';
import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import {
  deleteSeparatorInText, insertModAtWinningEnd, insertSeparatorAtIndexInText, moveModsInText, moveSeparatorsInText,
  parseModlist, removeModFromText, setEnabledInText,
} from './codecs/modlistText';
import { readGameName, readSelectedProfile, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { spliceDownloadMeta, trashDownloadMeta } from './downloadMeta';
import { downloadsDirectoryResolver } from './downloadsDirectory';
import { factsOf, get, listDir, listFolders, putIfChanged, write, exists } from './files';
import {
  dataFolderOf, gameDirectoryResolver, type GameDetectors, type GameDirectoryOverrides, type GameFolder,
} from './gameDirectory';
import type {
  DataFolderPlugins, DownloadedFile, DownloadedFileMark, DownloadedFiles, InstanceAdapter, ModMeta, ModOrderChange,
  OwnedMetaKeys, PluginOrderChange,
} from './instanceAdapter';
import {
  downloadFile, downloadSidecarFile, isTempWrite, modlistFile, modMetaFile, modMetaFileIn, modsDir, pluginsFile,
  profilesDir, settingsFile,
} from './layout';
import { isPluginFile } from './pluginFile';

export interface Mo2InstanceOptions {
  instanceRoot: string;
  gameDirectoryOverrides: () => GameDirectoryOverrides;
  /** Steam and Wine detection; the real ones when omitted. */
  detectors?: GameDetectors;
}

// A missing file answers `absent`; any other failure rejects.
async function readOrAbsent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return absent;
  }
}

function applyModOrderChange(text: string, change: ModOrderChange): string {
  switch (change.kind) {
    case 'enable': return setEnabledInText(text, change.mod, change.enabled);
    case 'moveMods': return moveModsInText(text, change.mods, change.place, change.end);
    case 'moveSeparators': return moveSeparatorsInText(text, change.separators, change.place, change.end);
    case 'addMod': return insertModAtWinningEnd(text, change.mod);
    case 'addSeparator': return insertSeparatorAtIndexInText(text, change.separator, change.afterIndex);
    case 'dropMod': return removeModFromText(text, change.mod);
    case 'dropSeparator': return deleteSeparatorInText(text, change.separator);
  }
}

function applyPluginOrderChange(text: string, change: PluginOrderChange): string {
  switch (change.kind) {
    case 'enable': return setPluginEnabledInText(text, change.plugin, change.enabled);
    case 'move': return movePluginsInText(text, [...change.plugins], change.toIndex);
    case 'add': return appendPluginInText(text, change.plugin);
    case 'drop': return removePluginFromText(text, change.plugin);
  }
}

// Excluded and included leave metadata that already says so untouched, so a file at rest gains
// no metadata.
function markIn(text: string, mark: DownloadedFileMark): string {
  switch (mark) {
    case 'Installed': return setInstalledInText(text);
    case 'Uninstalled': return setUninstalledInText(text);
    case 'Excluded':
    case 'Included': {
      const excluded = mark === 'Excluded';
      return parseDownloadMeta(text).excluded === excluded ? text : setHiddenInText(text, excluded);
    }
  }
}

// A key the upgrade does not supply keeps the carried meta's own value.
function keysOver(keys: OwnedMetaKeys, carried: ModMeta): OwnedMetaKeys {
  return {
    gameName: keys.gameName,
    modid: keys.modid ?? carried.nexusId,
    version: keys.version ?? carried.version,
    installationFile: keys.installationFile ?? carried.archiveFilename,
    installedFiles: keys.installedFiles ?? carried.installedFiles,
  };
}

async function listDownloadedFiles(downloadsDir: string): Promise<DownloadedFile[] | undefined> {
  const dirents = await readOrAbsent(() => listDir(downloadsDir), undefined);
  if (dirents === undefined) return undefined;
  const names = dirents
    .filter((d) => d.isFile() && !isTempWrite(d.name) && !d.name.endsWith(DOWNLOAD_SIDECAR_SUFFIX))
    .map((d) => d.name);
  return Promise.all(names.map(async (name) => {
    const [facts, metaText] = await Promise.all([
      factsOf(downloadFile(downloadsDir, name)),
      readOrAbsent<string | undefined>(() => get(downloadSidecarFile(downloadsDir, name)), undefined),
    ]);
    return {
      name, size: facts.size, mtimeMs: facts.mtimeMs, meta: metaText === undefined ? undefined : parseDownloadMeta(metaText),
    };
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

export function mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides, detectors }: Mo2InstanceOptions): InstanceAdapter {
  const resolveGameFolder = gameDirectoryResolver(gameDirectoryOverrides, detectors);
  const resolveDownloadsFolder = downloadsDirectoryResolver(detectors);

  return {
    async settings() {
      const iniText = await get(settingsFile(instanceRoot));
      return {
        profile: readSelectedProfile(iniText),
        gameName: readGameName(iniText),
        gameFolder: () => resolveGameFolder(iniText),
        downloadedFiles: async (): Promise<DownloadedFiles> => {
          const resolution = await resolveDownloadsFolder(instanceRoot, iniText);
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

    modMeta(mod) {
      return readOrAbsent(async () => parseMetaIni(await get(modMetaFile(instanceRoot, mod))), {});
    },

    modFolders(skippedLink) {
      return readOrAbsent<string[] | undefined>(() => listFolders(modsDir(instanceRoot), skippedLink), undefined);
    },

    async pluginOrder(profile) {
      return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
    },

    gameFolderPlugins: listGameFolderPlugins,

    changeModOrder(profile, decide) {
      return putIfChanged(modlistFile(instanceRoot, profile), async (text) =>
        (await decide(parseModlist(text))).reduce(applyModOrderChange, text));
    },

    changePluginOrder(profile, decide) {
      return putIfChanged(pluginsFile(instanceRoot, profile), async (text) =>
        (await decide(parsePlugins(text))).reduce(applyPluginOrderChange, text));
    },

    async markDownloadedFile(downloadsDir, name, mark) {
      if (!(await exists(downloadFile(downloadsDir, name)))) return { gone: true };
      const { wrote } = await spliceDownloadMeta(downloadsDir, name, (text) => markIn(text, mark));
      return { gone: false, wrote };
    },

    trashDownloadedFileMeta: trashDownloadMeta,

    async writeModMeta(folder, keys, carriedFrom) {
      if (carriedFrom === undefined) {
        await write(modMetaFileIn(folder), writeMetaIni(keys));
        return;
      }
      const carried = await get(modMetaFileIn(carriedFrom), '');
      await write(modMetaFileIn(folder), setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
    },

    selectProfile(profile) {
      return putIfChanged(settingsFile(instanceRoot), (text) =>
        (readSelectedProfile(text) === profile ? text : setSelectedProfileInText(text, profile)));
    },
  };
}
