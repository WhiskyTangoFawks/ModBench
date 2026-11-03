import type { Presence } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from './instance';

type PresenceFacts = Pick<InstanceValue, 'files' | 'plugins' | 'pluginsLoadedWithNoLine' | 'dataFolderPlugins' | 'dataFolderFiles'>;

/** Whether the game finds the file in its Data folder, as LOOT sees it; unknown while the Data folder cannot be listed and
 *  nothing else provides the file. A plugins.txt line that no file provides is not a file. */
export function filePresence(facts: PresenceFacts, relativePath: string): Presence {
  const normalised = relativePath.replace(/\\/g, '/');
  const folded = normalised.toLowerCase();
  const named = (name: string): boolean => name.toLowerCase() === folded;
  const { files, plugins, pluginsLoadedWithNoLine = [], dataFolderPlugins, dataFolderFiles } = facts;
  const found = files.get(normalised) !== undefined
    || plugins.some((plugin) => plugin.path !== undefined && named(plugin.name))
    || pluginsLoadedWithNoLine.some((plugin) => named(plugin.name))
    || (dataFolderPlugins.kind === 'listed' && [...dataFolderPlugins.names].some(named))
    || (dataFolderFiles.kind === 'listed' && dataFolderFiles.files.has(folded));
  if (found) return 'present';
  return dataFolderPlugins.kind === 'listed' && dataFolderFiles.kind === 'listed' ? 'absent' : 'unknown';
}

/** The files the game finds in its Data folder, `complete` while both listings of the folder read. */
export function filesPresent(facts: PresenceFacts): { names: readonly string[]; complete: boolean } {
  const { files, plugins, pluginsLoadedWithNoLine = [], dataFolderPlugins, dataFolderFiles } = facts;
  return {
    names: [
      ...[...files].map(({ relativePath }) => relativePath),
      ...plugins.flatMap(({ name, path }) => (path === undefined ? [] : [name])),
      ...pluginsLoadedWithNoLine.map(({ name }) => name),
      ...dataFolderPlugins.kind === 'listed' ? dataFolderPlugins.names : [],
      ...dataFolderFiles.kind === 'listed' ? dataFolderFiles.files : [],
    ],
    complete: dataFolderPlugins.kind === 'listed' && dataFolderFiles.kind === 'listed',
  };
}
