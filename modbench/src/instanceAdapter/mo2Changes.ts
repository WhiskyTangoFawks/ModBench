// MO2's changes to the plugin order, the profile, the mod folders and the downloaded files' metadata:
// each file spliced through its own codec under its lock and written whole.

import {
  appendPluginInText, movePluginsInText, parsePlugins, pluginKey, removePluginFromText, setPluginEnabledInText,
  type PluginEntry,
} from '../loadOrderFileCodec/pluginsText';
import { parseDownloadMeta, setHiddenInText, setInstalledInText, setUninstalledInText } from './codecs/downloads';
import { readSelectedProfile, setSelectedProfileInText } from './codecs/modOrganizerIni';
import { spliceDownloadMeta, trashDownloadMeta } from './downloadMeta';
import { ensureDir, exists, putIfChanged } from './files';
import type { DownloadedFileMark, InstanceAdapter, PluginOrderChange } from './instanceAdapter';
import { downloadFile, pluginsFile, settingsFile } from './layout';
import { currentDownloadsDir, folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';

export type Mo2Changes = Pick<InstanceAdapter,
  | 'changePluginOrder' | 'createModFolder' | 'trashEntryFolder' | 'markDownloadedFile'
  | 'trashDownloadedFileMeta' | 'selectProfile'>;

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
      return parseDownloadMeta(text).excluded === excluded ? text : setHiddenInText(text, excluded);
    }
  }
}

export function mo2Changes(context: Mo2Context): Mo2Changes {
  const { instanceRoot } = context;

  return {
    changePluginOrder(profile, decide) {
      return putIfChanged(pluginsFile(instanceRoot, profile), (text) =>
        decide(parsePlugins(text)).reduce(splicePluginOrderChange, text));
    },

    async createModFolder(mod) {
      const folder = newModFolder(context, mod);
      await refuseFolderTaken(context, { kind: 'mod', name: mod }, folder);
      await ensureDir(folder);
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
