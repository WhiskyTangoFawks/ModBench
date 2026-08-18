/** #331/#368: the one shared signal path every pending-change-state-aware provider is refreshed
 *  from — stage/save/revert (`SessionController`'s own callback), a webview's `PENDING_CHANGED`
 *  message (`recordPanelMessageRouter`), and session load/exit (`extension.ts`) all call this,
 *  never a provider's own `.refresh()` directly. Before this existed, `changeGroupTreeProvider`
 *  and `pendingChangeDecorationProvider` were paired by hand at three separate call sites (#331);
 *  the aggregate SCM provider (#368) is the second time a new pending-change-aware provider has
 *  needed wiring into all of them, and the risk that motivates this file is the third one landing
 *  with only two of three call sites updated. Adding a provider here is a one-function change
 *  instead of an N-call-site audit — the type signature itself is what a caller passing an
 *  incomplete set fails against, not a rule anyone has to remember. */
export interface PendingStateRefreshTargets {
  changeGroupTree: { refresh(): void };
  pendingChangeDecoration?: { refresh(retainOnFailure?: boolean): void };
  ledgerScm?: { refresh(): void };
}

export function refreshPendingState(targets: PendingStateRefreshTargets, retainOnFailure = true): void {
  targets.changeGroupTree.refresh();
  targets.pendingChangeDecoration?.refresh(retainOnFailure);
  targets.ledgerScm?.refresh();
}
