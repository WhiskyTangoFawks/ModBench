import type { MarkdownString } from 'vscode';

/** Stated structurally so this file imports from neither bounded context and needs no VS Code
 *  harness to test; the real `ExtensionSession` satisfies it by shape. */
export interface TeardownSession {
  loadOrderSync?: { abandon(): void };
  pluginsTree?: {
    refreshFacts(): Promise<{ name: string; hasMatchingRecords: boolean }[] | undefined>;
  };
  pluginsTreeView?: { message?: string | MarkdownString };
  pluginsNameFilter?: { refresh(): void };
}

/** `TreeView.message` is the native surface for a view-scoped statement about its own contents,
 *  so there is no banner row and no bespoke widget. */
export function say(session: TeardownSession, message: string | undefined): void {
  if (!session.pluginsTreeView) return;
  session.pluginsTreeView.message = message;
  // One message surface, two things that can want it: when the load stops talking, whatever the
  // name filter had to say comes back rather than staying silently swallowed.
  if (message === undefined) session.pluginsNameFilter?.refresh();
}

/** Takes the backend down. Nothing else: mEdit runs for the extension's whole lifetime, so no
 *  view has a shape to revert to and a disconnect is a status they surface (ADR-0022). */
export function exitEditing(session: TeardownSession, client: { stop(): Promise<void> }): void {
  // Abandon any reconcile still in flight *first*: it aborts the PUT, so the reconcile returns
  // 'abandoned' rather than reporting a killed backend to the user as a network failure.
  session.loadOrderSync?.abandon();
  // stop()'s body runs to completion whether or not the returned promise is awaited, so
  // fire-and-forget still defers the 'stopped' status correctly.
  void client.stop();
}

/** Re-reads the tree's own plugin facts, so a row reads the filter active now — including the
 *  record filter's `hasMatchingRecords`, which the tree applies to itself from this same read. */
export async function refreshMatchingPlugins(session: TeardownSession): Promise<void> {
  const tree = session.pluginsTree;
  if (!tree) return; // no tree means no load order to describe, not a failure
  await tree.refreshFacts();
}
