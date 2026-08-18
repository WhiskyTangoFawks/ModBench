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

/** Builds a target bundle from required *positional* parameters rather than an object literal
 *  with optional keys (#368 review, AC3 gap) — an object literal silently accepts a caller who
 *  forgets a key entirely; a positional parameter does not (a call site missing an argument is a
 *  compile error, not a runtime gap a test has to catch after the fact). `pendingChangeDecoration`/
 *  `ledgerScm` may each individually *be* `undefined` — activation order can construct one
 *  provider before another — but the caller must say so explicitly, not omit it. Extension.ts's
 *  two call sites (`SessionController`'s `refreshGroupTree` callback and the session-load reset in
 *  `makeEnterEditing`) both build their targets through this one function now, from the one
 *  `pendingStateTargets` value `activate()` constructs, rather than each writing its own inline
 *  object literal — the exact drift risk a fourth provider landing at only one of the two call
 *  sites would otherwise reintroduce. */
export function buildPendingStateTargets(
  changeGroupTree: PendingStateRefreshTargets['changeGroupTree'],
  pendingChangeDecoration: PendingStateRefreshTargets['pendingChangeDecoration'],
  ledgerScm: PendingStateRefreshTargets['ledgerScm'],
): PendingStateRefreshTargets {
  return { changeGroupTree, pendingChangeDecoration, ledgerScm };
}

/** Refreshes every target independently — a synchronous throw or a rejected async refresh from
 *  one target must not skip the others (#368 review: that would defeat the entire purpose of a
 *  *shared* signal). Each failure is logged via `log` (default a no-op, same convention as every
 *  other optional logger in this codebase) rather than swallowed, so it's visible without being
 *  fatal to the refresh as a whole. Returns a `Promise<void>` that always resolves, never rejects
 *  — callers that fire this and forget (matching the pre-#368 convention) can do so safely; the
 *  return value only exists so a caller that *wants* to wait for every target to settle (this
 *  file's own tests) genuinely can. */
export async function refreshPendingState(
  targets: PendingStateRefreshTargets,
  retainOnFailure = true,
  log: (msg: string) => void = () => {},
): Promise<void> {
  await Promise.all([
    runIsolated(() => targets.changeGroupTree.refresh(), 'changeGroupTree', log),
    runIsolated(() => targets.pendingChangeDecoration?.refresh(retainOnFailure), 'pendingChangeDecoration', log),
    runIsolated(() => targets.ledgerScm?.refresh(), 'ledgerScm', log),
  ]);
}

async function runIsolated(run: () => void | Promise<void>, name: string, log: (msg: string) => void): Promise<void> {
  try {
    await run();
  } catch (e) {
    log(`[refreshPendingState] ${name}.refresh() failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
