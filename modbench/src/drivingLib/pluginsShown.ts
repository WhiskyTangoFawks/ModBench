import type { PluginAddress } from '../wire/pluginAddress';

/** What the Plugins view's row shows of a plugin (plugins.md, A row, Plugin); what mEdit has not read yet is null. */
export interface PluginShown {
  readonly statuses: readonly { readonly status: string; readonly tooltip: string }[];
  readonly readOnly: boolean | null;
  readonly compiled: boolean | null;
  readonly masters: readonly string[] | null;
}

export interface PluginsShown {
  shown(plugin: PluginAddress): PluginShown;
}
