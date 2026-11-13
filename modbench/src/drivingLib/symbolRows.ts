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
}

export interface PluginRows extends RowsOf<PluginAddress> {
  /** The plugin's file on disk. */
  fileOf: (plugin: PluginAddress) => string | undefined;
}
