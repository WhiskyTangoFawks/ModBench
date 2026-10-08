import type { DownloadFile } from '../instanceLoader/instance';
import type { ArgumentOf } from '../wire/argument';
import type { PluginAddress } from '../wire/pluginAddress';

export type PluginArgument = ArgumentOf<'plugin'>;
export type ModArgument = ArgumentOf<'mod'>;

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isAddress = (value: unknown): value is PluginAddress =>
  typeof value === 'object' && value !== null && isString(Reflect.get(value, 'name')) && isString(Reflect.get(value, 'origin'));

/** What a row or webview context carries as its `argument`, read by shape so a gesture imports
 *  no box that builds one (ADR-0014). */
export function carriedArgument(carrier: unknown): object | undefined {
  if (typeof carrier !== 'object' || carrier === null) return undefined;
  const argument: unknown = Reflect.get(carrier, 'argument');
  return typeof argument === 'object' && argument !== null ? argument : undefined;
}

export function pluginArgumentOf(carrier: unknown): PluginArgument | undefined {
  const argument = carriedArgument(carrier);
  const plugin: unknown = argument && Reflect.get(argument, 'plugin');
  return argument && Reflect.get(argument, 'kind') === 'plugin' && isAddress(plugin) ? { kind: 'plugin', plugin } : undefined;
}

export function modArgumentOf(carrier: unknown): ModArgument | undefined {
  const argument = carriedArgument(carrier);
  const name: unknown = argument && Reflect.get(argument, 'name');
  return argument && Reflect.get(argument, 'kind') === 'mod' && isString(name) ? { kind: 'mod', name } : undefined;
}

/** What names the object a row stands for: its `name` when it has one, else the label it shows. */
export function rowLabelOf(carrier: unknown): string | undefined {
  if (typeof carrier !== 'object' || carrier === null) return undefined;
  const name: unknown = Reflect.get(carrier, 'name') ?? Reflect.get(carrier, 'label');
  return typeof name === 'string' ? name : undefined;
}

/** What names a row in a refusal. */
export const rowNameOf = (carrier: unknown): string => rowLabelOf(carrier) ?? 'a selected row';

/** A downloaded file. */
export interface DownloadArgument {
  readonly kind: 'download';
  readonly row: DownloadFile;
}

export function downloadArgumentOf(carrier: unknown): DownloadArgument | undefined {
  const argument = carriedArgument(carrier);
  const isDownload = (value: object): value is DownloadArgument =>
    Reflect.get(value, 'kind') === 'download' && typeof Reflect.get(value, 'row') === 'object';
  return argument && isDownload(argument) ? argument : undefined;
}
