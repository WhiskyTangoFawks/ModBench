import { carriedArgument, isAddress, isString, type ArgumentAddress } from './argument';

/** `editorId` only names the record in a question. */
export interface RecordArgument {
  readonly kind: 'record';
  readonly plugin: ArgumentAddress;
  readonly formKey: string;
  readonly editorId?: string;
}

export function recordArgumentOf(carrier: unknown): RecordArgument | undefined {
  const argument = carriedArgument(carrier);
  if (!argument || Reflect.get(argument, 'kind') !== 'record') return undefined;
  const plugin: unknown = Reflect.get(argument, 'plugin');
  const formKey: unknown = Reflect.get(argument, 'formKey');
  const editorId: unknown = Reflect.get(argument, 'editorId');
  if (!isAddress(plugin) || !isString(formKey)) return undefined;
  return isString(editorId) ? { kind: 'record', plugin, formKey, editorId } : { kind: 'record', plugin, formKey };
}
