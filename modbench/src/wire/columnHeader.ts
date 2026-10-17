import { isPluginAddress } from './messages';
import type { PluginAddress } from './pluginAddress';

// A record tab's column header carries its record's Argument, whose plugin the gesture acts on (editor.md, Menus and keys).
export function columnHeaderOf(value: unknown): PluginAddress | undefined {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'webviewSection') !== 'recordHeader') return undefined;
  const argument: unknown = Reflect.get(value, 'argument');
  const plugin: unknown = typeof argument === 'object' && argument !== null ? Reflect.get(argument, 'plugin') : undefined;
  return isPluginAddress(plugin) ? plugin : undefined;
}
