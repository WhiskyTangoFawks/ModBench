// MO2's implementation of the Instance adapter: each file read or spliced through its own codec
// and written whole.

import {
  appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText,
  type PluginEntry,
} from '../loadOrderFileCodec/pluginsText';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import {
  DOWNLOAD_SIDECAR_SUFFIX, parseDownloadMeta, setHiddenInText, setInstalledInText, setUninstalledInText,
} from './codecs/downloads';
import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import {
  deleteSeparatorInText, entryNamed, insertModAtWinningEnd, insertSeparatorAtIndexInText, moveModsInText,
  moveSeparatorsInText, OVERWRITE_DIR_NAME, parseModlist, removeModFromText, renameSeparatorInText,
  separatorModName, setEnabledInText,
} from './codecs/modlistText';
import { readGameName, readSelectedProfile, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { spliceDownloadMeta, trashDownloadMeta } from './downloadMeta';
import { downloadsDirectoryResolver } from './downloadsDirectory';
import {
  ensureDir, exists, factsOf, get, listDir, listFolders, makeTempDir, putIfChanged, remove, rename, write,
} from './files';
import {
  dataFolderOf, gameDirectoryResolver, type GameDetectors, type GameDirectoryOverrides, type GameFolder,
} from './gameDirectory';
import type {
  DataFolderPlugins, DownloadedFile, DownloadedFileMark, DownloadedFiles, EntryRef, InstanceAdapter, ModFolder,
  ModlistEntry, ModMeta, ModOrderChange, OwnedMetaKeys, PluginOrderChange,
} from './instanceAdapter';
import {
  downloadFile, downloadNameAt, downloadSidecarFile, entryDir, fileInFolder, isTempWrite, mo2FolderName, modDir,
  modlistFile, modMetaFile, modMetaFileIn, modsDir, pluginsFile, profilesDir, separatorDir, settingsFile,
  stagingPrefix,
} from './layout';
import { isPluginFile } from './pluginFile';

export interface Mo2InstanceOptions {
  instanceRoot: string;
  gameDirectoryOverrides: () => GameDirectoryOverrides;
  /** Steam and Wine detection; the real ones when omitted. */
  detectors?: GameDetectors;
}

type Undo = () => Promise<void>;

// A missing file answers `absent`; any other failure rejects.
async function readOrAbsent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return absent;
  }
}

const NOUN = { mod: 'Mod', separator: 'Separator' } as const;

function requireListed(order: readonly ModlistEntry[], entry: EntryRef): void {
  if (!order.some((e) => e.kind === entry.kind && e.name === entry.name)) {
    throw new Error(`${NOUN[entry.kind]} not found in modlist: ${entry.name}`);
  }
}

function requireUnlisted(order: readonly ModlistEntry[], entry: EntryRef): void {
  if (order.some((e) => e.kind === entry.kind && e.name === entry.name)) {
    throw new Error(`${NOUN[entry.kind]} already in modlist: ${entry.name}`);
  }
}

// Every entry a change names is checked against the order it lands on, so none is dropped in
// silence.
function checkModOrderChange(order: readonly ModlistEntry[], change: ModOrderChange): void {
  const mod = (name: string): EntryRef => ({ kind: 'mod', name });
  const separator = (name: string): EntryRef => ({ kind: 'separator', name });
  switch (change.kind) {
    case 'enable': return requireListed(order, mod(change.mod));
    case 'moveMods': return change.mods.forEach((name) => requireListed(order, mod(name)));
    case 'moveSeparators': return change.separators.forEach((name) => requireListed(order, separator(name)));
    case 'addAtWinningEnd': return requireUnlisted(order, change.entry);
    case 'addSeparator': return requireUnlisted(order, separator(change.separator));
    case 'renameSeparator':
      requireListed(order, separator(change.from));
      if (change.to !== change.from) requireUnlisted(order, separator(change.to));
      return;
    case 'dropMod': return requireListed(order, mod(change.mod));
    case 'dropSeparator': return requireListed(order, separator(change.separator));
  }
}

function spliceModOrderChange(text: string, change: ModOrderChange): string {
  switch (change.kind) {
    case 'enable': return setEnabledInText(text, change.mod, change.enabled);
    case 'moveMods': return moveModsInText(text, change.mods, change.place, change.end);
    case 'moveSeparators': return moveSeparatorsInText(text, change.separators, change.place, change.end);
    case 'addAtWinningEnd': {
      const { kind, name } = change.entry;
      return insertModAtWinningEnd(text, kind === 'separator' ? separatorModName(name) : name);
    }
    case 'addSeparator': return insertSeparatorAtIndexInText(text, change.separator, change.afterIndex);
    case 'renameSeparator': return renameSeparatorInText(text, change.from, change.to);
    case 'dropMod': return removeModFromText(text, change.mod);
    case 'dropSeparator': return deleteSeparatorInText(text, change.separator);
  }
}

const applyModOrderChange = (text: string, change: ModOrderChange): string => {
  checkModOrderChange(parseModlist(text), change);
  return spliceModOrderChange(text, change);
};

function checkPluginOrderChange(order: readonly PluginEntry[], change: PluginOrderChange): void {
  const listed = (plugin: string): boolean => order.some((p) => p.name === plugin);
  const requireListedPlugin = (plugin: string): void => {
    if (!listed(plugin)) throw new Error(`Plugin not found in plugins.txt: ${plugin}`);
  };
  switch (change.kind) {
    case 'enable': return requireListedPlugin(change.plugin);
    case 'move': return change.plugins.forEach(requireListedPlugin);
    case 'add':
      if (listed(change.plugin)) throw new Error(`Plugin already in plugins.txt: ${change.plugin}`);
      return;
    case 'drop': return requireListedPlugin(change.plugin);
  }
}

function splicePluginOrderChange(text: string, change: PluginOrderChange): string {
  switch (change.kind) {
    case 'enable': return setPluginEnabledInText(text, change.plugin, change.enabled);
    case 'move': return movePluginsInText(text, [...change.plugins], change.toIndex);
    case 'add': return appendPluginInText(text, change.plugin);
    case 'drop': return removePluginFromText(text, change.plugin);
  }
}

const applyPluginOrderChange = (text: string, change: PluginOrderChange): string => {
  checkPluginOrderChange(parsePlugins(text), change);
  return splicePluginOrderChange(text, change);
};

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

// The folders each undo puts back, newest first; a failed undo is named beside the failure it
// followed.
async function undoAll(undos: readonly Undo[], err: unknown): Promise<unknown> {
  for (const undo of undos) {
    try {
      await undo();
    } catch (undoErr) {
      return new Error(`${errorMessage(err)}; a folder could not be put back: ${errorMessage(undoErr)}`);
    }
  }
  return err;
}

export function mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides, detectors }: Mo2InstanceOptions): InstanceAdapter {
  const resolveGameFolder = gameDirectoryResolver(gameDirectoryOverrides, detectors);
  const resolveDownloadsFolder = downloadsDirectoryResolver(detectors);

  const downloadsFolder = async (): Promise<string> => {
    const resolution = await resolveDownloadsFolder(instanceRoot, await get(settingsFile(instanceRoot)));
    if (resolution.kind === 'unresolved') throw new Error(resolution.reason);
    return resolution.downloadsDir;
  };

  const modFolderOf = (mod: string): string => {
    const folder = entryDir(instanceRoot, { kind: 'mod', name: mod });
    if (folder === undefined) throw new Error(`Not a valid mod name: "${mod}"`);
    return folder;
  };

  const separatorFolderOf = (separator: string): string => {
    const folder = separatorDir(instanceRoot, separator);
    if (folder === undefined) throw new Error(`Not a valid separator name: "${separator}"`);
    return folder;
  };

  const listModFolders = async (skippedLink?: (name: string, reason: string) => void): Promise<ModFolder[] | undefined> => {
    const names = await readOrAbsent<string[] | undefined>(() => listFolders(modsDir(instanceRoot), skippedLink), undefined);
    return names
      ?.filter((name) => name.toLowerCase() !== OVERWRITE_DIR_NAME)
      .map((name) => ({ ...entryNamed(name), path: modDir(instanceRoot, name) }));
  };

  // A separator's folder moves with its line; anything else in mod order is a line alone.
  const moveFolders = async (change: ModOrderChange): Promise<Undo | undefined> => {
    if (change.kind === 'addSeparator') {
      const folder = separatorFolderOf(change.separator);
      if (await exists(folder)) return undefined;
      await ensureDir(folder);
      return () => remove(folder);
    }
    if (change.kind === 'renameSeparator') {
      const from = separatorDir(instanceRoot, change.from);
      const to = separatorFolderOf(change.to);
      if (from === undefined || from === to || !(await exists(from))) return undefined;
      await rename(from, to);
      return () => rename(to, from);
    }
    return undefined;
  };

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

    modFolders: listModFolders,

    async pluginOrder(profile) {
      return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
    },

    gameFolderPlugins: listGameFolderPlugins,

    folderNameFor: mo2FolderName,

    async hasModFolder(mod) {
      const folder = entryDir(instanceRoot, { kind: 'mod', name: mod });
      return folder !== undefined && exists(folder);
    },

    async downloadedFileAt(path) {
      const resolution = await resolveDownloadsFolder(instanceRoot, await get(settingsFile(instanceRoot)));
      return resolution.kind === 'unresolved' ? undefined : downloadNameAt(resolution.downloadsDir, path);
    },

    async changeModOrder(profile, decide) {
      const undos: Undo[] = [];
      try {
        return await putIfChanged(modlistFile(instanceRoot, profile), async (text) => {
          const changes = decide(parseModlist(text), await listModFolders());
          const after = changes.reduce(applyModOrderChange, text);
          for (const change of changes) {
            const undo = await moveFolders(change);
            if (undo) undos.unshift(undo);
          }
          return after;
        });
      } catch (err) {
        throw await undoAll(undos, err);
      }
    },

    changePluginOrder(profile, decide) {
      return putIfChanged(pluginsFile(instanceRoot, profile), (text) =>
        decide(parsePlugins(text)).reduce(applyPluginOrderChange, text));
    },

    async createModFolder(mod) {
      await ensureDir(modFolderOf(mod));
    },

    async trashEntryFolder(entry, trash) {
      const folder = entryDir(instanceRoot, entry);
      if (folder === undefined || !(await exists(folder))) return false;
      await trash(folder);
      return true;
    },

    async markDownloadedFile(name, mark) {
      const downloadsDir = await downloadsFolder();
      if (!(await exists(downloadFile(downloadsDir, name)))) return { gone: true };
      const { wrote } = await spliceDownloadMeta(downloadsDir, name, (text) => markIn(text, mark));
      return { gone: false, wrote };
    },

    async trashDownloadedFileMeta(name, trash) {
      return trashDownloadMeta(await downloadsFolder(), name, trash);
    },

    stagingFolder: () => makeTempDir(stagingPrefix(instanceRoot)),

    async landNewMod(mod, staged, keys) {
      const folder = modFolderOf(mod);
      await write(modMetaFileIn(staged), writeMetaIni(keys));
      await ensureDir(modsDir(instanceRoot));
      await rename(staged, folder);
    },

    // The meta the mod had is read before its contents go, so its own keys survive the release.
    async upgradeMod(mod, staged, keys, keep) {
      const folder = modFolderOf(mod);
      const carried = await get(modMetaFileIn(folder), '');
      const kept = new Set((await listDir(folder)).map((d) => d.name).filter(keep));
      for (const entry of await listDir(folder)) {
        if (!kept.has(entry.name)) await remove(fileInFolder(folder, entry.name));
      }
      for (const entry of await listDir(staged)) {
        if (!kept.has(entry.name)) await rename(fileInFolder(staged, entry.name), fileInFolder(folder, entry.name));
      }
      await write(modMetaFileIn(folder), setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
    },

    selectProfile(profile) {
      return putIfChanged(settingsFile(instanceRoot), (text) =>
        (readSelectedProfile(text) === profile ? text : setSelectedProfileInText(text, profile)));
    },
  };
}
