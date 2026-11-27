import type { PluginAddress } from '../../client';

/** A Plugins row as VS Code hands it to a source gesture. */
export const pluginRow = (plugin: PluginAddress) => ({ argument: { kind: 'plugin', plugin }, label: plugin.name });

/** A record tab's column header as VS Code hands it to a source gesture. */
export const columnHeader = (plugin: PluginAddress) => ({ webviewSection: 'recordHeader', argument: { kind: 'record', formKey: `000801:${plugin.name}`, plugin } });

export const PLUGINS_VIEW = 'modbench.pluginListTree';
