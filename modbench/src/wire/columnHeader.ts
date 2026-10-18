import { isPluginAddress, isString } from './messages';
import type { PluginAddress } from './pluginAddress';

// A record tab's column header carries its record's Argument, whose plugin the gesture acts on (editor.md, Menus and keys).
export function columnHeaderOf(value: unknown): PluginAddress | undefined {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'webviewSection') !== 'recordHeader') return undefined;
  const argument: unknown = Reflect.get(value, 'argument');
  if (typeof argument !== 'object' || argument === null) return undefined;
  const plugin: unknown = Reflect.get(argument, 'plugin');
  return Reflect.get(argument, 'kind') === 'record' && isString(Reflect.get(argument, 'formKey')) && isPluginAddress(plugin) ? plugin : undefined;
}
