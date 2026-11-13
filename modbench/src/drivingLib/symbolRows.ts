import type { PluginAddress } from '../wire/pluginAddress';

export type Reveal = () => PromiseLike<void>;

interface RowsOf<Held> {
  selected: () => unknown;
  show: (held: Held) => Reveal | undefined;
}

export interface ModRows extends RowsOf<string> {
  folderOf: (mod: string) => string | undefined;
  /** The path in the Data folder a file row stands for; undefined for any other argument. */
  fileOf: (clicked: unknown) => string | undefined;
}

export interface PluginRows extends RowsOf<PluginAddress> {
  fileOf: (plugin: PluginAddress) => string | undefined;
}
