import * as vscode from 'vscode';

/**
 * #428: a synthetic `medit-record:` URI identifies one record row — (plugin, origin, formKey), the
 * same compound identity ADR-0036 already requires everywhere a record row is addressed — so
 * {@link RecordDecorationProvider} (`RecordDecorationProvider.ts`) has a `resourceUri` to key its
 * `FileDecorationProvider` on.
 *
 * Deliberately synthetic rather than the source file's own real path on disk. The source JSON is a
 * real file, but once a mod is tracked it already sits inside a repo `vscode.git` has opened
 * (`registerTrackedRepositories`) — reusing that path would put a second, independent decoration
 * source on the exact same URI, answering a different question (git's own index/staging state, not
 * this product's Effective/Head divergence: a newly created, unstaged record reads "Untracked" to
 * git, not "Added"). The synthetic scheme also means the frontend never needs the real source path
 * at all, which today only the backend computes (`SourceRecordPath`, internal to
 * `MEditService.Core`).
 *
 * Identity only, never state (#428 orchestrator ruling) — `WorkingTreeState` never appears in the
 * URI. Encoding volatile state into a resourceUri would make every dirty/clean transition a
 * different URI string, which is exactly the kind of stale-identity churn VS Code's tree/selection
 * machinery is not built to absorb silently. The decoration provider instead holds its own live
 * lookup, keyed by this same identity.
 */
const SCHEME = 'medit-record';

export function recordResourceUri(plugin: string, origin: string | undefined, formKey: string): vscode.Uri {
  const path = ['', plugin, origin ?? '', formKey].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
  return vscode.Uri.from({ scheme: SCHEME, path });
}

export interface RecordResourceIdentity {
  plugin: string;
  origin: string;
  formKey: string;
}

/** The inverse of {@link recordResourceUri} — undefined for any URI outside the `medit-record:`
 *  scheme, so a decoration provider can guard on it the same way every existing provider in this
 *  codebase guards on its own real-path prefix (`HiddenDownloadDecorationProvider`,
 *  `ImplicitMasterDecorationProvider`). */
export function parseRecordResourceUri(uri: vscode.Uri): RecordResourceIdentity | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const [, plugin, origin, formKey] = uri.path.split('/').map(decodeURIComponent);
  if (plugin === undefined || origin === undefined || formKey === undefined) return undefined;
  return { plugin, origin, formKey };
}
