// MO2's changes: each file spliced through its own codec under its lock and written whole; a
// separator's folder moves with its line.

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
import { ensureDir, exists, putIfChanged, remove, rename } from './files';
import type {
  DownloadedFileMark, EntryRef, InstanceAdapter, ModlistEntry, ModOrderChange, PluginOrderChange,
} from './instanceAdapter';
import { downloadFile, entryDir, modlistFile, pluginsFile, separatorDir, settingsFile } from './layout';
import { currentDownloadsDir, listModFolders, modFolderOf, type Mo2Context } from './mo2Context';

export type Mo2Changes = Pick<InstanceAdapter,
  | 'changeModOrder' | 'changePluginOrder' | 'createModFolder' | 'trashEntryFolder' | 'markDownloadedFile'
  | 'trashDownloadedFileMeta' | 'selectProfile'>;

type Undo = () => Promise<void>;

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
    async changeModOrder(profile, decide) {
      const undos: Undo[] = [];
      try {
        return await putIfChanged(modlistFile(instanceRoot, profile), async (text) => {
          const changes = decide(parseModlist(text), await listModFolders(context));
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
      await ensureDir(modFolderOf(context, mod));
    },

    async trashEntryFolder(entry, trash) {
      const folder = entryDir(instanceRoot, entry);
      if (folder === undefined || !(await exists(folder))) return false;
      await trash(folder);
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
