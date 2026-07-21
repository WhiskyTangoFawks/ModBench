import type { components } from './generated/api';

// Pure ADR-0026 save-outcome classification, shared by the extension host (SessionController)
// and the record-editor webview (RecordPanel's Pending column). Deliberately imports nothing but
// the generated `components` types: the webview bundles this, so it must not drag in any
// extension-host graph (vscode, sessionFailures, …).

export type SaveResult = components['schemas']['SaveResult'];
export type ReindexFailure = components['schemas']['ReindexFailure'];
/** The single-group save answers with a per-plugin outcome map plus an optional reindex
 *  failure, even on HTTP 200 (ADR-0026: structured failure, frontend surfaces it). */
export type SaveOutcome = { [plugin: string]: SaveResult };

export type PluginSaveStatus = 'saved' | 'partial' | 'failed';

const count = (list: readonly string[] | null | undefined): number => list?.length ?? 0;

/** Classify a plugin's save outcome. Records can be left unwritten (read-only target,
 *  missing record, failed create) while others applied — that plugin partially saved,
 *  not wholly failed (ADR-0026: per-plugin accuracy). */
export function classifyPluginSave(r: SaveResult): PluginSaveStatus {
  const unwritten = count(r.readOnly) + count(r.notFound) + count(r.createFailed);
  if (unwritten === 0) return 'saved';
  return count(r.applied) > 0 ? 'partial' : 'failed';
}

/** Split a group save's per-plugin outcome map into saved / partially-written / failed plugin
 *  names (ADR-0026 integrity tier). Returns null when nothing needs surfacing — every plugin
 *  wrote cleanly — so a caller can stay silent on the happy path. */
export function summarizePartialSave(
  byPlugin: SaveOutcome | undefined,
): { saved: string[]; partial: string[]; failed: string[] } | null {
  if (!byPlugin) return null;
  const saved: string[] = [];
  const partial: string[] = [];
  const failed: string[] = [];
  for (const [plugin, r] of Object.entries(byPlugin)) {
    ({ saved, partial, failed }[classifyPluginSave(r)]).push(plugin);
  }
  if (partial.length === 0 && failed.length === 0) return null;
  return { saved, partial, failed };
}

/** The ADR-0026 partial-save message: names which plugins wrote, partially wrote, and could
 *  not write, and states that the unwritten changes stay queued. Null when nothing needs
 *  surfacing. Shared so the extension host and the record panel word it identically. */
export function partialSaveMessage(byPlugin: SaveOutcome | undefined): string | null {
  const split = summarizePartialSave(byPlugin);
  if (!split) return null;
  const parts: string[] = [];
  if (split.saved.length > 0) parts.push(`wrote ${split.saved.join(', ')}`);
  if (split.partial.length > 0) parts.push(`partially wrote ${split.partial.join(', ')}`);
  if (split.failed.length > 0) parts.push(`could not write ${split.failed.join(', ')}`);
  return `Partial save — ${parts.join('; ')}. Unwritten changes remain queued.`;
}

/** #127 / ADR-0026 warning tier: the save reached disk but the post-commit reindex failed, so
 *  the record views serve stale pre-save data. A warning to reload, never a "save failed"
 *  error. Null when the reindex succeeded. Shared so both surfaces word it identically. */
export function staleIndexMessage(failure: ReindexFailure | null | undefined): string | null {
  if (!failure) return null;
  const plugins = (failure.plugins ?? []).join(', ') || 'the saved plugins';
  return `Saved ${plugins}, but the index is now stale — reload the session to refresh the record views.`;
}
