import type { PluginAddress } from '../../client';

/** A Plugins row as VS Code hands it to a source gesture. */
export const pluginRow = (plugin: PluginAddress) => ({ argument: { kind: 'plugin', plugin }, label: plugin.name });

/** A record tab's column header as VS Code hands it to a source gesture. */
export const columnHeader = (plugin: PluginAddress) => ({ webviewSection: 'recordHeader', argument: { kind: 'record', formKey: `000801:${plugin.name}`, plugin } });

/** A separator's Argument as a carrier hands it to a gesture: the Mods view's separator row carries none. */
export const separatorCarrier = (name: string) => ({ argument: { kind: 'separator', name }, name });

export const PLUGINS_VIEW = 'modbench.pluginListTree';
