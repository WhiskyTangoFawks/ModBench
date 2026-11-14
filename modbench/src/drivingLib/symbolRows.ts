import type { PluginAddress } from '../wire/pluginAddress';

export type Reveal = () => PromiseLike<void>;

interface RowsOf<Held> {
  selected: () => unknown;
  show: (held: Held) => Reveal | undefined;
}

export interface ModRows extends RowsOf<string> {
  /** The mod's folder on disk. */
  folderOf: (mod: string) => string | undefined;
  /** The path in the Data folder a file row stands for; undefined for any other argument. */
  dataPathOf: (clicked: unknown) => string | undefined;
  /** The tooltip of the row of the copy of the file at its path in the Data folder that the game gets; undefined where Mods
   *  shows no such row. */
  fileTooltip: (path: string) => string | undefined;
}

export interface PluginRows extends RowsOf<PluginAddress> {
  /** The plugin's file on disk. */
  fileOf: (plugin: PluginAddress) => string | undefined;
}
