import { carriedArgument } from './argument';
import { isPluginAddress, isString } from '../wire/messages';
import type { ArgumentOf } from '../wire/argument';
import type { PluginAddress } from '../wire/pluginAddress';

export type RecordArgument = ArgumentOf<'record'>;

export function recordArgumentOf(carrier: unknown): RecordArgument | undefined {
  const argument = carriedArgument(carrier);
  if (!argument || Reflect.get(argument, 'kind') !== 'record') return undefined;
  const formKey: unknown = Reflect.get(argument, 'formKey');
  const plugin: unknown = Reflect.get(argument, 'plugin');
  if (!isString(formKey)) return undefined;
  if (plugin === undefined) return { kind: 'record', formKey };
  return isPluginAddress(plugin) ? { kind: 'record', formKey, plugin } : undefined;
}

// A record tab's column header carries its record's Argument, whose plugin the gesture acts on (editor.md, Menus and keys).
export function columnHeaderOf(value: unknown): PluginAddress | undefined {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'webviewSection') === 'recordHeader'
    ? recordArgumentOf(value)?.plugin : undefined;
}
