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
 *
 * `fromConflictsNode` (#364 review finding) is not an exception to that rule — it is fixed for a
 * node's whole lifetime at construction (which tree location built this row), never a live value
 * that changes underneath an already-rendered row the way `WorkingTreeState` would.
 */
const SCHEME = 'medit-record';

/** #364 review finding: the conflict badge must render only on the Conflicts node's own rows, not
 *  on every location a record happens to appear (the AC's explicit scope decision — Option B's
 *  "badge everywhere" is deliberately not built). `RecordDecorationProvider` is registered once,
 *  globally, keyed purely on this URI's identity — with no location marker, a record's ordinary
 *  `RecordTypeNode -> RecordNode` row would inherit a badge that belongs to its Conflicts-node
 *  row instead, since both would otherwise resolve to the identical URI. This query-string marker
 *  is what a row `PluginTreeProvider.fetchConflicts` built carries and an ordinary row never does,
 *  so the decoration provider can gate the conflict lookup on it while the M/A working-tree lookup
 *  (correctly location-independent — a local edit is a fact about the record, not about where it's
 *  being viewed) keeps using identity alone. */
const CONFLICTS_NODE_QUERY = 'conflicts=1';

export function recordResourceUri(
  plugin: string, origin: string | undefined, formKey: string, fromConflictsNode = false,
): vscode.Uri {
  const path = ['', plugin, origin ?? '', formKey].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
  return vscode.Uri.from({ scheme: SCHEME, path, query: fromConflictsNode ? CONFLICTS_NODE_QUERY : undefined });
}

export interface RecordResourceIdentity {
  plugin: string;
  origin: string;
  formKey: string;
  /** #364 review finding: whether this URI was built for a row under the Conflicts node
   *  specifically — see the module-level doc comment above {@link CONFLICTS_NODE_QUERY}. */
  fromConflictsNode: boolean;
}

/** The inverse of {@link recordResourceUri} — undefined for any URI outside the `medit-record:`
 *  scheme, so a decoration provider can guard on it the same way every existing provider in this
 *  codebase guards on its own real-path prefix (`HiddenDownloadDecorationProvider`,
 *  `ImplicitMasterDecorationProvider`). */
export function parseRecordResourceUri(uri: vscode.Uri): RecordResourceIdentity | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const [, plugin, origin, formKey] = uri.path.split('/').map(decodeURIComponent);
  if (plugin === undefined || origin === undefined || formKey === undefined) return undefined;
  return { plugin, origin, formKey, fromConflictsNode: uri.query === CONFLICTS_NODE_QUERY };
}
