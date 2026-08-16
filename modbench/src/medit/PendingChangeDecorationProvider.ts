import * as vscode from 'vscode';
import type { ApiClient } from './ApiClient';
import { decorationDescriptorFor, decorationKindFor, type PendingChangeSummary } from './pendingChangeDecoration';
import { parseRowIdentity } from './pendingChangeRowUri';

/** #331: `vscode.FileDecorationProvider` for pending-change state on the Plugins tree — a git-
 *  style badge + theme color on any row (plugin or record) that carries a staged change.
 *
 *  Q2 (#331 investigation): there is no push channel from the backend for "pending state
 *  changed" — every existing signal in this codebase is the extension host being told, after the
 *  fact, by whichever call site just mutated state (the webview's `PENDING_CHANGED` message,
 *  `SessionController`'s save/revert/create/copy/delete calls). `refresh()` below is wired to
 *  those same call sites (`extension.ts`), which is what keeps this event-driven with no polling
 *  (AC4). It deliberately performs its *own* `GET /changes` fetch rather than sharing
 *  `PendingChangesTreeProvider`'s: that provider only fetches while the Pending Changes *view*
 *  is actually visible (`TreeDataProvider.getChildren` is demand-driven by VS Code), so relying
 *  on its fetch would silently stop decorating the Plugins tree the moment that view is
 *  collapsed. Reading the same backend endpoint — the single source of truth — twice at the same
 *  trigger points is not a second derivation of "which rows are dirty"; `decorationKindFor` is
 *  the one and only place that logic lives, and this class never duplicates it.
 */
export class PendingChangeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private changes: PendingChangeSummary[] = [];
  private readonly log: (msg: string) => void;

  constructor(
    private readonly client: ApiClient,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (() => {});
  }

  /** Empties the decoration set deterministically — no HTTP call, so no race against the backend
   *  process actually finishing termination. `exitToLoadout()` (extension.ts) calls this, not
   *  `refresh()`: once there is no session, "no pending changes" is already a known fact (the
   *  same reason `pluginsTree?.setSession(undefined)`/`recordBrowserProvider?.setImmutablePlugins([])`
   *  next to it are direct resets too, not re-fetches) — a `refresh()` immediately after
   *  `backendManager.stop()` could race the still-terminating process and read one more
   *  momentarily-live response before the connection actually drops. */
  clear(): void {
    this.changes = [];
    this._onDidChangeFileDecorations.fire(undefined);
  }

  /** Re-reads `/changes` and tells VS Code every currently-rendered decoration may have changed.
   *  Called from every place pending-change state can change (extension.ts) — never on a timer.
   *
   *  #334 decision 1: a failed fetch leaves `this.changes` exactly as it was — retained, not
   *  cleared — wherever `this.changes` is a trustworthy baseline from the *current* session.
   *  Stale-but-flagged beats confidently-empty there: the post-mutation call sites (the webview's
   *  `PENDING_CHANGED` message, `SessionController`'s save/revert/create/copy/delete) only ever
   *  fetch what they themselves just changed, so the worst case of retaining is briefly showing
   *  pre-mutation state. #334 decision 2: retaining is why those call sites sit at ADR-0026's
   *  background/recoverable tier (inline UI + log, no toast) rather than the silent-wrong-state
   *  tier that would otherwise apply.
   *
   *  Session entry (`makeEnterEditing`, extension.ts) has no such baseline: `this.changes` may
   *  still hold a *previous* session's entries (#331's stale-decoration guard), so retaining on a
   *  failed entry fetch would leak them into the new session as if they were live — the exact
   *  silent-wrong-state failure #334 exists to prevent, at a different call site (#334 review).
   *  That call site passes `retainOnFailure: false` to opt out and clear instead.
   *
   *  @param retainOnFailure Default `true` — retain on failure, safe wherever the caller has a
   *    trustworthy current-session baseline. Pass `false` only where it doesn't. */
  async refresh(retainOnFailure = true): Promise<void> {
    try {
      const { data, response } = await this.client.GET('/changes', {});
      if (!response.ok || !Array.isArray(data)) {
        this.log(`[PendingChangeDecorationProvider] /changes fetch failed (${response.status}) — ` +
          (retainOnFailure ? 'retaining last-known decorations' : 'clearing (no trustworthy baseline)'));
        if (!retainOnFailure) this.changes = [];
      } else {
        this.changes = data.map((c) => ({ formKey: c.formKey ?? '', plugin: c.plugin ?? '', changeType: c.changeType ?? '' }));
      }
    } catch (e) {
      this.log(`[PendingChangeDecorationProvider] refresh threw: ${e instanceof Error ? e.message : String(e)} — ` +
        (retainOnFailure ? 'retaining last-known decorations' : 'clearing (no trustworthy baseline)'));
      if (!retainOnFailure) this.changes = [];
    }
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const identity = parseRowIdentity(uri);
    if (!identity) return undefined;
    const descriptor = decorationDescriptorFor(decorationKindFor(this.changes, identity));
    if (!descriptor) return undefined;
    return { badge: descriptor.badge, color: new vscode.ThemeColor(descriptor.colorId), tooltip: descriptor.tooltip };
  }
}
