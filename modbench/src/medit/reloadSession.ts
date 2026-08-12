/** #295: Reload Session's decision logic — confirm only when there is something to lose, and
 *  never touch the session at all when the user declines. No VS Code types in the signature
 *  (same style as `recordPanelMessageRouter`/`sessionFailures`, which take their deps directly
 *  rather than through a factory — one call site, so this does too): `extension.ts` wires the
 *  real modal and the real reload path in; this is what stays unit-testable without a harness. */
export interface ReloadSessionDeps {
  /** The live "is there staged work right now" read — `SessionController.hasPendingChanges()`
   *  in production. Fails toward `true` on its own, so this function never has to. */
  hasPendingChanges: () => Promise<boolean>;
  /** The native modal (`showWarningMessage(…, { modal: true })`) — resolves `true` only if the
   *  user picked the affirmative action, `false` for Cancel/Escape/dismiss alike. */
  confirm: () => Promise<boolean>;
  /** The reused session-load path (`makeEnterEditing`, wrapped with progress and its own
   *  failure handling). Never called when the user declines the confirm — cancelling must be
   *  structurally a no-op, not merely "skip reporting a change", so nothing about the running
   *  session is touched. */
  reload: () => Promise<void>;
}

export async function reloadSession(deps: ReloadSessionDeps): Promise<void> {
  if (await deps.hasPendingChanges()) {
    const confirmed = await deps.confirm();
    if (!confirmed) return;
  }
  await deps.reload();
}
