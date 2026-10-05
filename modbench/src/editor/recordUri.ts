import * as vscode from 'vscode';
import { headerFormKeyOf } from '../wire/headerFormKey';
import type { PluginAddress } from '../wire/pluginAddress';

export const RECORD_EDITOR_VIEW_TYPE = 'modbench.record';

const SCHEME = 'modbench-record';
const SUFFIX = '.modbench-record';

/** A Plugin Header record is named by its plugin's address, since its FormKey names only the
 *  plugin's filename (ADR-0012). */
export type RecordTabAddress = { formKey: string } | { header: PluginAddress };

export function recordUri(address: RecordTabAddress): vscode.Uri {
  const [named, query] = 'header' in address
    ? [address.header.name, new URLSearchParams({ origin: address.header.origin }).toString()]
    : [address.formKey, ''];
  return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(named)}${SUFFIX}`, query });
}

export function recordTabAddressOf(uri: vscode.Uri): RecordTabAddress {
  const named = decodeURIComponent(uri.path.slice(1, -SUFFIX.length));
  const origin = new URLSearchParams(uri.query).get('origin');
  return origin === null ? { formKey: named } : { header: { name: named, origin } };
}

/** The FormKey mEdit answers the record at. */
export function formKeyOf(address: RecordTabAddress): string {
  return 'header' in address ? headerFormKeyOf(address.header) : address.formKey;
}
