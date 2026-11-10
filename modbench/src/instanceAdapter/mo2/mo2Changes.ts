// MO2's changes to the plugin order, the profile, the mod folders and the downloaded files' metadata:
// each file spliced through its own codec under its lock and written whole.

import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import type { NexusFileInfo } from '../../ports/nexusFileInfo';
import { firstLines } from '../../loadOrderFileCodec/firstLines';
import {
  appendPluginInText, movePluginsInText, parsePlugins, pluginKey, removePluginFromText, setPluginEnabledInText,
  type PluginEntry,
} from '../../loadOrderFileCodec/pluginsText';
import { loadOrderTextOf } from './codecs/loadOrderText';
import { parseDownloadedFileMeta, setHiddenInText, setInstalledInText, setNexusFileInfoInText, setUninstalledInText } from './codecs/downloads';
import { readSelectedProfile, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { spliceDownloadedFileMeta, trashDownloadedFileMeta } from './downloadedFileMeta';
import { ensureDir, exists, get, isRepository, putIfChanged, putStreamedIf, readOrAbsent, remove, rename, undoAll, type Undo, withLock, write } from '../files';
import { git } from '../git';
import { digestOf } from '../fileContents/contentDigest';
import { entryNotFound, type DownloadedFileMark, InstanceAdapter, PluginOrderChange } from '../instanceAdapter';
import { downloadedFileMetadataPath, downloadedFilePath, everyModlistFile, pluginOrderFiles, settingsFile, sortingRuleFilePaths } from './layout';
import { parseModlist } from './codecs/modlistText';
import { addLoadAfter } from '../../sortingRules/lootMetadata';
import { currentDownloadsDir, entryKey, folderHolding, listedAs, newModFolder, metaGameOfDomain, refuseFolderTaken, type Mo2Context } from './mo2Context';
import { readPluginsProvided, type ReadingSource } from '../instanceReading';

type Mo2Changes = Pick<InstanceAdapter,
  | 'changePluginOrder' | 'changePluginOrderOverProvided' | 'createModFolder' | 'renameModFolder' | 'trashEntryFolder' | 'markDownloadedFile' | 'writeNexusFileInfo'
  | 'putDownloadedFile' | 'copyDownloadedFile' | 'trashDownloadedFile' | 'selectProfile' | 'changeUserlist' | 'changeMasterlist' | 'uncommittedMasterlist'>;

async function heldDownloadedFile(context: Mo2Context, name: string): Promise<{ downloadsDir: string; file: string } | undefined> {
  const downloadsDir = await currentDownloadsDir(context);
  const file = downloadedFilePath(downloadsDir, name);
  return (await exists(file)) ? { downloadsDir, file } : undefined;
}

function listedPlugin(order: readonly PluginEntry[], plugin: string): string {
  const listed = order.find((p) => pluginKey(p.name) === pluginKey(plugin));
  if (listed === undefined) throw new Error(`Plugin not found in plugins.txt: ${plugin}`);
  return listed.name;
}

function splicePluginOrderChange(text: string, change: PluginOrderChange): string {
  const order = parsePlugins(text);
  const listed = (plugin: string): string => listedPlugin(order, plugin);
  switch (change.kind) {
    case 'enable': return setPluginEnabledInText(text, listed(change.plugin), change.enabled);
    case 'move': return movePluginsInText(text, change.plugins.map(listed), change.toIndex);
    case 'add':
      return order.some((p) => pluginKey(p.name) === pluginKey(change.plugin)) ? text : appendPluginInText(text, change.plugin);
    case 'drop': return removePluginFromText(text, listed(change.plugin));
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
      return parseDownloadedFileMeta(text).hidden === excluded ? text : setHiddenInText(text, excluded);
    }
  }
}

async function metaGameOfDomainOrThrow(context: Mo2Context, domain: string): Promise<string> {
  const game = await metaGameOfDomain(context, domain);
  if (game === undefined) throw new Error(`Modbench has no game for the Nexus game '${domain}'`);
  return game;
}

const pluginOrderIn = (text: string): PluginEntry[] => firstLines(parsePlugins(text), ({ name }) => pluginKey(name)).kept;

async function putDownloadedFile(
  context: Mo2Context, name: string, bytes: AsyncIterable<Uint8Array>, { hash, info }: { readonly hash?: string; readonly info: NexusFileInfo },
): Promise<{ readonly put: boolean }> {
  if (basename(name) !== name || name === '..') throw new Error(`'${name}' is not a file name`);
  const downloadsDir = await currentDownloadsDir(context);
  const file = downloadedFilePath(downloadsDir, name);
  const gameName = await metaGameOfDomainOrThrow(context, info.game);
  return withLock(file, async () => {
    if (await exists(file)) throw new Error(`'${name}' is already in the downloads folder`);
    await ensureDir(downloadsDir);
    if (!(await putStreamedIf(file, bytes, async (temp) => hash === undefined || (await digestOf(temp)) === hash))) return { put: false };
    try {
      const metadata = downloadedFileMetadataPath(downloadsDir, name);
      await withLock(metadata, () => write(metadata, setNexusFileInfoInText('', info, gameName)));
    } catch (err) {
      await remove(file);
      throw err;
    }
    return { put: true };
  });
}

async function copyDownloadedFile(context: Mo2Context, from: string, name: string): Promise<void> {
  if (basename(name) !== name || name === '..') throw new Error(`'${name}' is not a file name`);
  const downloadsDir = await currentDownloadsDir(context);
  const file = downloadedFilePath(downloadsDir, name);
  await withLock(file, async () => {
    if (await exists(file)) throw new Error(`'${name}' is already in the downloads folder`);
    await ensureDir(downloadsDir);
    await copyFile(from, file, constants.COPYFILE_EXCL);
    const metadata = downloadedFileMetadataPath(dirname(from), basename(from));
    try {
      if (await exists(metadata)) await copyFile(metadata, downloadedFileMetadataPath(downloadsDir, name), constants.COPYFILE_EXCL);
    } catch (err) {
      await remove(file);
      throw err;
    }
  });
}

async function listedInAModOrder({ instanceRoot }: Mo2Context, mod: string): Promise<boolean> {
  const orders = await Promise.all((await everyModlistFile(instanceRoot)).map((file) => readOrAbsent(() => get(file), '')));
  return orders.some((text) => listedAs(parseModlist(text), { kind: 'mod', name: mod }) !== undefined);
}

export function mo2Changes(context: Mo2Context, source: ReadingSource): Mo2Changes {
  const { instanceRoot } = context;

  // MO2 takes the order from loadorder.txt and only the enabled state from plugins.txt, so a
  // changed plugins.txt brings loadorder.txt with it.
  function putPluginOrder(profile: string, edit: (before: string) => string | Promise<string>): Promise<{ wrote: boolean }> {
    const [loadOrder, plugins] = pluginOrderFiles(instanceRoot, profile);
    return withLock(loadOrder, () => putIfChanged(plugins, async (before) => {
      const after = await edit(before);
      if (after !== before) await write(loadOrder, loadOrderTextOf(after));
      return after;
    }));
  }

  return {
    changePluginOrder(profile, decide) {
      return putPluginOrder(profile, (text) => decide(pluginOrderIn(text)).reduce(splicePluginOrderChange, text));
    },

    changePluginOrderOverProvided(profile, decide) {
      return putPluginOrder(profile, async (text) => {
        const order = pluginOrderIn(text);
        return decide(order, await readPluginsProvided(source, profile)).reduce(splicePluginOrderChange, text);
      });
    },

    async createModFolder(mod) {
      const folder = newModFolder(context, mod);
      await refuseFolderTaken(context, { kind: 'mod', name: mod }, folder);
      await ensureDir(folder);
    },

    async renameModFolder(from, to) {
      const holding = await folderHolding(context, { kind: 'mod', name: from });
      const target = newModFolder(context, to);
      // A folder already at its new name, as VS Code's rename leaves it, has moved; one a mod order lists is another mod's.
      if (holding === undefined && await exists(target) && !await listedInAModOrder(context, to)) return;
      if (holding === undefined) throw new Error(entryNotFound({ kind: 'mod', name: from }));
      if (entryKey(holding) !== entryKey({ kind: 'mod', name: to })) {
        await refuseFolderTaken(context, { kind: 'mod', name: to }, target);
      }
      await rename(holding.path, target);
    },

    async trashEntryFolder(entry, trash) {
      const folder = await folderHolding(context, entry);
      if (folder === undefined) return false;
      await trash(folder.path);
      return true;
    },

    async markDownloadedFile(name, mark) {
      const held = await heldDownloadedFile(context, name);
      if (held === undefined) return { gone: true };
      const { downloadsDir } = held;
      const { wrote } = await spliceDownloadedFileMeta(downloadsDir, name, (text) => markIn(text, mark));
      return { gone: false, wrote };
    },

    async writeNexusFileInfo(name, info) {
      const held = await heldDownloadedFile(context, name);
      if (held === undefined) return { gone: true };
      const gameName = await metaGameOfDomainOrThrow(context, info.game);
      const { wrote } = await spliceDownloadedFileMeta(held.downloadsDir, name, (text) => setNexusFileInfoInText(text, info, gameName));
      return { gone: false, wrote };
    },

    putDownloadedFile: (name, bytes, file) => putDownloadedFile(context, name, bytes, file),

    copyDownloadedFile: (from, name) => copyDownloadedFile(context, from, name),

    async trashDownloadedFile(name, trash) {
      const held = await heldDownloadedFile(context, name);
      if (held === undefined) return { gone: true };
      const { downloadsDir, file } = held;
      await trash(file);
      try {
        await trashDownloadedFileMeta(downloadsDir, name, trash);
      } catch (err) {
        return { gone: false, metadataLeftBehind: errorMessage(err) };
      }
      return { gone: false };
    },

    changeUserlist(additions) {
      return putIfChanged(sortingRuleFilePaths(instanceRoot).userlist, (before) => addLoadAfter(before, additions), { ifMissing: '' });
    },

    changeMasterlist({ masterlist, prelude }) {
      const paths = sortingRuleFilePaths(instanceRoot);
      return withLock(paths.masterlist, () => withLock(paths.prelude, async () => {
        const undos: Undo[] = [];
        const written: string[] = [];
        try {
          for (const [path, text] of [[paths.masterlist, masterlist], [paths.prelude, prelude]] as const) {
            const before = (await exists(path)) ? await get(path) : undefined;
            if (before === text) continue;
            await write(path, text);
            undos.unshift(() => (before === undefined ? remove(path) : write(path, before)));
            written.push(basename(path));
          }
        } catch (err) {
          throw await undoAll(undos, err);
        }
        return { written };
      }));
    },

    async uncommittedMasterlist() {
      if (!(await isRepository(instanceRoot))) return [];
      const paths = sortingRuleFilePaths(instanceRoot);
      const files = [basename(paths.masterlist), basename(paths.prelude)];
      const status = await git(instanceRoot, 'status', '--porcelain', '-z', '--no-renames', '--', ...files);
      return status.split('\0').filter((entry) => entry !== '').map((entry) => entry.slice(3));
    },

    selectProfile(profile) {
      return putIfChanged(settingsFile(instanceRoot), (text) =>
        (readSelectedProfile(text) === profile ? text : setSelectedProfileInText(text, profile)));
    },
  };
}
