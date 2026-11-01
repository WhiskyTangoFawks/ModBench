import type { InstanceValue } from './instance';

/** Whether the game finds a file at `relativePath` in its Data folder: a winning file of mod order, or a plugin the
 *  instance holds, which includes the game folder's own. As LOOT sees the Data folder. */
export function fileIsPresent({ files, plugins }: Pick<InstanceValue, 'files' | 'plugins'>, relativePath: string): boolean {
  const folded = relativePath.toLowerCase();
  return files.get(relativePath.replace(/\\/g, '/')) !== undefined || plugins.some((plugin) => plugin.name.toLowerCase() === folded);
}
