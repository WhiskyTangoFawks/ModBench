import * as vscode from 'vscode';
import { present } from '../ports/present';
import type { PluginAddress } from '../wire/pluginAddress';

const SCHEME = 'medit-record';
const ROW_SCHEME = 'medit-row';

const encoded = (segments: readonly string[]) => segments.map((s) => `/${encodeURIComponent(s)}`).join('');

/** Identity only, never working-tree state: a URI changing on every dirty/clean transition
 *  would churn VS Code's tree identity. Synthetic rather than the real source path, which
 *  `vscode.git` decorates with its own answer. */
export function recordResourceUri({ name, origin }: PluginAddress, formKey: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: encoded([name, origin, formKey]) });
}

export interface RecordResourceIdentity {
  plugin: PluginAddress;
  formKey: string;
}

/** Undefined for any URI outside the `medit-record:` scheme, so a decoration provider asked
 *  about someone else's URI can guard on it. */
export function parseRecordResourceUri(uri: vscode.Uri): RecordResourceIdentity | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const parts = uri.path.split('/').map(decodeURIComponent);
  if (parts.length < 4) return undefined;
  const name = present(parts[1], 'plugin segment in a medit-record URI');
  const origin = present(parts[2], 'origin segment in a medit-record URI');
  const formKey = present(parts[3], 'formKey segment in a medit-record URI');
  return { plugin: { name, origin }, formKey };
}

/** A row that is no record of its own: the plugin, a record type, a block, a group. `path` names it
 *  beneath its plugin, so the same row keeps the same URI across a rebuild. */
export function rowResourceUri({ name, origin }: PluginAddress, ...path: string[]): vscode.Uri {
  return vscode.Uri.from({ scheme: ROW_SCHEME, path: encoded([name, origin, ...path]) });
}

export interface RowResourceIdentity {
  plugin: PluginAddress;
  path: readonly string[];
}

export function parseRowResourceUri(uri: vscode.Uri): RowResourceIdentity | undefined {
  if (uri.scheme !== ROW_SCHEME) return undefined;
  const [, name, origin, ...path] = uri.path.split('/').map(decodeURIComponent);
  return { plugin: { name: present(name, 'plugin segment in a medit-row URI'), origin: present(origin, 'origin segment in a medit-row URI') }, path };
}
