import { carriedArgument, isAddress, isString } from './argument';
import type { ArgumentOf } from '../wire/argument';

export type RecordArgument = ArgumentOf<'record'>;

export function recordArgumentOf(carrier: unknown): RecordArgument | undefined {
  const argument = carriedArgument(carrier);
  if (!argument || Reflect.get(argument, 'kind') !== 'record') return undefined;
  const formKey: unknown = Reflect.get(argument, 'formKey');
  const plugin: unknown = Reflect.get(argument, 'plugin');
  if (!isString(formKey)) return undefined;
  if (plugin === undefined) return { kind: 'record', formKey };
  return isAddress(plugin) ? { kind: 'record', formKey, plugin } : undefined;
}
