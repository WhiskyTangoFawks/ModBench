/** #331: the pure "row identity + live pending-change state → decoration, or none" derivation —
 *  no VS Code types anywhere in this file, so it is unit-testable without a harness and is the
 *  one and only place that decides which rows read as dirty. `PendingChangeDecorationProvider`
 *  (the `vscode.FileDecorationProvider`) is thin glue around this: fetch, parse the URI, call in.
 */

/** 'created' renders as git's 'added' treatment (a pending record creation, changeType `create`);
 *  'modified' covers every other changeType (`field_edit`, `delete`, `renumber`,
 *  `vmad_struct_op`) — the brief names only these two variants, so this ticket doesn't invent a
 *  third for delete/renumber. */
export type ChangeKind = 'created' | 'modified';

/** The slice of a backend `PendingChange` this derivation needs — deliberately not the full wire
 *  type: no `origin` field. ADR-0036/`EditOrchestrator.ResolveOrigin` always resolve *some*
 *  origin server-side for a staged edit (staging only ever targets the current winning copy —
 *  `PatchRecordRequest` has no origin parameter), so a backend-reported origin string is never
 *  what tells a shadowed row apart from a winning one; the row's own `origin` (present only on a
 *  shadowed-copy row, ADR-0036) is what does that, in `RowIdentity` below. */
export interface PendingChangeSummary {
  formKey: string;
  plugin: string;
  changeType: string;
}

/** A tree row's identity, exactly as much as this derivation needs — never a VS Code TreeItem. A
 *  'record' row covers every formKey-addressable Plugins-tree row (RecordNode, and the spatial
 *  WorldspaceNode/CellNode/PlacedNode — ADR-0035 AC: an undecorated row must never be mistakable
 *  for "no pending changes" once decoration exists at all, so every row that can carry a pending
 *  change needs this identity, not just the flat record list). */
export type RowIdentity =
  | { kind: 'plugin'; plugin: string }
  | { kind: 'record'; plugin: string; formKey: string; origin?: string };

const CREATE_CHANGE_TYPE = 'create';

/** The decoration a row should carry given the live set of pending changes, or `undefined` for a
 *  clean row. */
export function decorationKindFor(
  changes: readonly PendingChangeSummary[],
  row: RowIdentity,
): ChangeKind | undefined {
  // Plugin-filename comparisons are case-insensitive throughout this codebase (session files,
  // master issues, read-only/immutable sets — PluginsTreeComposite.setSession et al.); matching
  // exactly here would silently miss a decoration if the backend's casing of a plugin name ever
  // diverges from plugins.txt's own.
  const samePlugin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (row.kind === 'plugin') {
    // Uniform 'modified' whenever the plugin contains ANY staged change, even a pure creation —
    // matching git's own folder-containing-a-new-file treatment. 'added' is reserved for the
    // thing that is itself new; once #288 makes a *plugin* the pending-created thing, plugin-level
    // 'added' becomes correct there, not here.
    return changes.some((c) => samePlugin(c.plugin, row.plugin)) ? 'modified' : undefined;
  }

  // ADR-0036: only the winning copy of a plugin is ever staged against — the backend always
  // resolves the current winning origin server-side (PatchRecordRequest carries no origin
  // parameter), so staging can never target a shadowed copy in the first place. A row with an
  // `origin` IS that shadowed copy: permanently read-only, so it can never truly have a pending
  // change. Without this guard, a shadowed row would light up whenever the *winning* copy of the
  // same filename has a pending edit on the same formKey — the exact `(formKey, plugin)` collision
  // ADR-0036 exists to prevent, just moved into this derivation instead of the primary key.
  if (row.origin !== undefined) return undefined;

  const matches = changes.filter((c) => samePlugin(c.plugin, row.plugin) && c.formKey === row.formKey);
  if (matches.length === 0) return undefined;
  return matches.some((c) => c.changeType === CREATE_CHANGE_TYPE) ? 'created' : 'modified';
}

export interface DecorationDescriptor {
  badge: string;
  colorId: string;
  tooltip: string;
}

/** `ChangeKind` → the badge/theme-color/tooltip to render — git's own vocabulary
 *  (`gitDecoration.*ResourceForeground`), never a hardcoded color, so the treatment follows the
 *  user's theme the way git's own Explorer decorations do. */
export function decorationDescriptorFor(kind: ChangeKind | undefined): DecorationDescriptor | undefined {
  if (kind === 'created') {
    return { badge: 'A', colorId: 'gitDecoration.addedResourceForeground', tooltip: 'Pending creation' };
  }
  if (kind === 'modified') {
    return { badge: 'M', colorId: 'gitDecoration.modifiedResourceForeground', tooltip: 'Has pending changes' };
  }
  return undefined;
}
