import * as vscode from 'vscode';
import type { RowIdentity } from './pendingChangeDecoration';

/** #331: the resourceUri schemes `PendingChangeDecorationProvider` recognizes. Not `file:` —
 *  `vscode.FileDecorationProvider` isn't restricted to real filesystem paths (the same way git's
 *  own SCM decorations aren't), and these rows have no meaningful filesystem identity of their
 *  own to reuse. Two schemes, not one, so a foreign URI (a real file, another provider's scheme)
 *  is rejected by `parseRowIdentity` without ambiguity. */
export const PENDING_PLUGIN_SCHEME = 'medit-pending-plugin';
export const PENDING_RECORD_SCHEME = 'medit-pending-record';

/** A plugin row's identity URI — just the filename; ADR-0036 origin ambiguity doesn't apply here
 *  (the Plugins tree's own root rows are always the winning copy — a shadowed copy never gets its
 *  own top-level plugin row). */
export function pluginRowUri(plugin: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PENDING_PLUGIN_SCHEME, path: `/${encodeURIComponent(plugin)}` });
}

/** A record (or spatial-node) row's identity URI. `origin`, when present (a shadowed copy,
 *  ADR-0036), rides in the query string so `parseRowIdentity` can round-trip it back into
 *  `RowIdentity` — `decorationKindFor` is what actually acts on its presence. */
export function recordRowUri(plugin: string, formKey: string, origin?: string): vscode.Uri {
  const params = new URLSearchParams({ formKey });
  if (origin !== undefined) params.set('origin', origin);
  return vscode.Uri.from({ scheme: PENDING_RECORD_SCHEME, path: `/${encodeURIComponent(plugin)}`, query: params.toString() });
}

/** The inverse of `pluginRowUri`/`recordRowUri` — `undefined` for any URI neither one produced
 *  (a real file, another provider's scheme), so `PendingChangeDecorationProvider` can no-op fast
 *  for the vast majority of URIs it's asked about. */
export function parseRowIdentity(uri: { scheme: string; path: string; query: string }): RowIdentity | undefined {
  if (uri.scheme === PENDING_PLUGIN_SCHEME) {
    return { kind: 'plugin', plugin: decodeURIComponent(uri.path.slice(1)) };
  }
  if (uri.scheme === PENDING_RECORD_SCHEME) {
    const params = new URLSearchParams(uri.query);
    const formKey = params.get('formKey');
    if (formKey === null) return undefined;
    const origin = params.get('origin');
    return {
      kind: 'record',
      plugin: decodeURIComponent(uri.path.slice(1)),
      formKey,
      origin: origin ?? undefined,
    };
  }
  return undefined;
}
