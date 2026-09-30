// MO2's changes: each file spliced through its own codec under its lock and written whole; a
// separator's folder moves with its line, under the same lock.

import {
  appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText,
  type PluginEntry,
} from '../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../ports/errorMessage';
import { parseDownloadMeta, setHiddenInText, setInstalledInText, setUninstalledInText } from './codecs/downloads';
import {
  deleteSeparatorInText, insertModAtWinningEnd, insertSeparatorAtIndexInText, moveModsInText, moveSeparatorsInText,
  parseModlist, removeModFromText, renameSeparatorInText, separatorModName, setEnabledInText,
} from './codecs/modlistText';
import { readSelectedProfile, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { spliceDownloadMeta, trashDownloadMeta } from './downloadMeta';
import { ensureDir, exists, get, putIfChanged, remove, rename, withLock, write } from './files';
import type {
  DownloadedFileMark, EntryRef, InstanceAdapter, ModlistEntry, ModOrderChange, MovePlace, PluginOrderChange,
  SeparatorsPlace,
} from './instanceAdapter';
import { downloadFile, mo2FolderName, modlistFile, pluginsFile, separatorDir, settingsFile } from './layout';
import {
  currentDownloadsDir, entryKey, folderHolding, listModFolders, modFoldersOf, newModFolder, type Mo2Context,
} from './mo2Context';

export type Mo2Changes = Pick<InstanceAdapter,
  | 'changeModOrder' | 'changePluginOrder' | 'createModFolder' | 'trashEntryFolder' | 'markDownloadedFile'
  | 'trashDownloadedFileMeta' | 'selectProfile'>;

type Undo = () => Promise<void>;

const NOUN = { mod: 'Mod', separator: 'Separator' } as const;

// The name mod order lists an entry under, matched as MO2 matches names.
function listedName(order: readonly ModlistEntry[], entry: EntryRef): string {
  const listed = order.find((e) => entryKey(e) === entryKey(entry));
  if (listed === undefined) throw new Error(`${NOUN[entry.kind]} not found in modlist: ${entry.name}`);
  return listed.name;
}

function requireUnlisted(order: readonly ModlistEntry[], entry: EntryRef): void {
  if (order.some((e) => entryKey(e) === entryKey(entry))) {
    throw new Error(`${NOUN[entry.kind]} already in modlist: ${entry.name}`);
  }
}

// A separator takes the name MO2 gives its folder.
function separatorName(requested: string): string {
  const name = mo2FolderName(requested);
  if (name === '') throw new Error(`Not a valid separator name: "${requested}"`);
  return name;
}

// The change with each name it names as mod order lists it, and each new name as MO2 gives it; a
// name that is not there, or one added that is, rejects.
function resolveModOrderChange(order: readonly ModlistEntry[], change: ModOrderChange): ModOrderChange {
  const mod = (name: string): string => listedName(order, { kind: 'mod', name });
  const separator = (name: string): string => listedName(order, { kind: 'separator', name });
  const separatorsPlace = (place: SeparatorsPlace): SeparatorsPlace =>
    (place.kind === 'separator' ? { kind: 'separator', name: separator(place.name) } : place);
  const movePlace = (place: MovePlace): MovePlace =>
    (place.kind === 'mod' ? { kind: 'mod', name: mod(place.name) } : place.kind === 'ungrouped' ? place : separatorsPlace(place));
  switch (change.kind) {
    case 'enable': return { ...change, mod: mod(change.mod) };
    case 'moveMods': return { ...change, mods: change.mods.map(mod), place: movePlace(change.place) };
    case 'moveSeparators': return { ...change, separators: change.separators.map(separator), place: separatorsPlace(change.place) };
    case 'addAtWinningEnd':
      requireUnlisted(order, change.entry);
      return change;
    case 'addSeparator': {
      const name = separatorName(change.separator);
      requireUnlisted(order, { kind: 'separator', name });
      return { ...change, separator: name };
    }
    case 'renameSeparator': {
      const from = separator(change.from);
      const to = separatorName(change.to);
      if (entryKey({ kind: 'separator', name: to }) !== entryKey({ kind: 'separator', name: from })) {
        requireUnlisted(order, { kind: 'separator', name: to });
      }
      return { ...change, from, to };
    }
    case 'dropMod': return { ...change, mod: mod(change.mod) };
    case 'dropSeparator': return { ...change, separator: separator(change.separator) };
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

// Plugin filenames match as the game matches them, ignoring case (ADR-0012).
const pluginKey = (name: string): string => name.toLowerCase();

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
      if (order.some((p) => pluginKey(p.name) === pluginKey(change.plugin))) {
        throw new Error(`Plugin already in plugins.txt: ${change.plugin}`);
      }
      return appendPluginInText(text, change.plugin);
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
      return parseDownloadMeta(text).excluded === excluded ? text : setHiddenInText(text, excluded);
    }
  }
}

// Every undo is tried, newest first, and each one that fails is named beside the failure it
// followed.
async function undoAll(undos: readonly Undo[], err: unknown): Promise<unknown> {
  const failures: string[] = [];
  for (const undo of undos) {
    try {
      await undo();
    } catch (undoErr) {
      failures.push(errorMessage(undoErr));
    }
  }
  if (failures.length === 0) return err;
  return new Error(`${errorMessage(err)}; not put back: ${failures.join('; ')}`);
}

export function mo2Changes(context: Mo2Context): Mo2Changes {
  const { instanceRoot } = context;

  const separatorFolderOf = (separator: string): string => {
    const folder = separatorDir(instanceRoot, separator);
    if (folder === undefined) throw new Error(`Not a valid separator name: "${separator}"`);
    return folder;
  };

  // A separator's folder moves with its line; anything else in mod order is a line alone.
  const moveFolders = async (change: ModOrderChange): Promise<Undo | undefined> => {
    if (change.kind === 'addSeparator') {
      if (await folderHolding(context, { kind: 'separator', name: change.separator })) return undefined;
      const folder = separatorFolderOf(change.separator);
      await ensureDir(folder);
      return () => remove(folder);
    }
    if (change.kind === 'renameSeparator') {
      const from = (await folderHolding(context, { kind: 'separator', name: change.from }))?.path;
      const to = separatorFolderOf(change.to);
      if (from === undefined || from === to) return undefined;
      await rename(from, to);
      return () => rename(to, from);
    }
    return undefined;
  };

  return {
    // The folders move, the file is written and any move is put back, all under the file's one
    // lock, so no change queued behind this one sees a folder this one moved and then undid.
    changeModOrder(profile, decide) {
      const file = modlistFile(instanceRoot, profile);
      return withLock(file, async () => {
        const before = await get(file);
        const folders = await listModFolders(context);
        const changes = decide(parseModlist(before), folders && modFoldersOf(folders));
        let after = before;
        const resolved: ModOrderChange[] = [];
        for (const change of changes) {
          const landing = resolveModOrderChange(parseModlist(after), change);
          resolved.push(landing);
          after = spliceModOrderChange(after, landing);
        }
        const undos: Undo[] = [];
        try {
          for (const change of resolved) {
            const undo = await moveFolders(change);
            if (undo) undos.unshift(undo);
          }
          if (after === before) return { wrote: false };
          await write(file, after);
          return { wrote: true };
        } catch (err) {
          throw await undoAll(undos, err);
        }
      });
    },

    changePluginOrder(profile, decide) {
      return putIfChanged(pluginsFile(instanceRoot, profile), (text) =>
        decide(parsePlugins(text)).reduce(splicePluginOrderChange, text));
    },

    async createModFolder(mod) {
      await ensureDir(newModFolder(context, mod));
    },

    async trashEntryFolder(entry, trash) {
      const folder = await folderHolding(context, entry);
      if (folder === undefined) return false;
      await trash(folder.path);
      return true;
    },

    async markDownloadedFile(name, mark) {
      const downloadsDir = await currentDownloadsDir(context);
      if (!(await exists(downloadFile(downloadsDir, name)))) return { gone: true };
      const { wrote } = await spliceDownloadMeta(downloadsDir, name, (text) => markIn(text, mark));
      return { gone: false, wrote };
    },

    async trashDownloadedFileMeta(name, trash) {
      return trashDownloadMeta(await currentDownloadsDir(context), name, trash);
    },

    selectProfile(profile) {
      return putIfChanged(settingsFile(instanceRoot), (text) =>
        (readSelectedProfile(text) === profile ? text : setSelectedProfileInText(text, profile)));
    },
  };
}
