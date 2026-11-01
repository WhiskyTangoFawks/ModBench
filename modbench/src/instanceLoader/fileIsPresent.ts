import type { InstanceValue } from './instance';

type PresenceFacts = Pick<InstanceValue, 'files' | 'plugins' | 'pluginsLoadedWithNoLine' | 'dataFolderPlugins'>;

/** Whether the game finds the file in its Data folder, as LOOT sees it. A plugins.txt line that no file provides is not a file. */
export function fileIsPresent(facts: PresenceFacts, relativePath: string): boolean {
  const folded = relativePath.toLowerCase();
  const named = (name: string): boolean => name.toLowerCase() === folded;
  const { files, plugins, pluginsLoadedWithNoLine = [], dataFolderPlugins } = facts;
  return files.get(relativePath.replace(/\\/g, '/')) !== undefined
    || plugins.some((plugin) => plugin.path !== undefined && named(plugin.name))
    || pluginsLoadedWithNoLine.some((plugin) => named(plugin.name))
    || (dataFolderPlugins.kind === 'listed' && [...dataFolderPlugins.names].some(named));
}
