import type { PluginRepository } from './PluginRepository';
import type { SessionController } from './SessionController';
import type { ExternalChangeDialogAnswer, ShowExternalChangeDialog } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import type { PendingExternalChange, RebaseResult } from './ApiClient';

/** #417: Absorb Upstream Update's own follow-up — a separate, non-modal notification, never folded
 *  into the dialog itself (the pinned contract's own words: "then the rebase offer as a separate,
 *  non-modal notification"). */
export const REBASE_NOW_BUTTON = 'Rebase Now';
export const REBASE_LATER_BUTTON = 'Later';

/** The edit branch's fixed name (CONTEXT.md's "Edit branch") — never derived per mod, so it is
 *  always this literal in the offer's own text. */
const EDIT_BRANCH_NAME = 'edit';

export function rebaseOfferMessage(origin: string): string {
  return `main moved ahead of "${EDIT_BRANCH_NAME}" in ${origin}.`;
}

/** The one shape this module needs from `vscode.window.showInformationMessage` — same injection
 *  idiom as {@link ShowExternalChangeDialog}, non-modal (no `{ modal: true }` option). */
export type ShowRebaseOffer = (message: string, ...buttons: string[]) => Thenable<string | undefined> | Promise<string | undefined>;

/** Opens one conflicted path in VS Code's native merge editor — an injected side effect (never a
 *  direct `vscode` import here) so the dispatch logic below stays testable without a host.
 *  `origin` rides along explicitly (rather than left for the callback to re-derive) because the
 *  dialog-driven path has no single already-resolved origin the way the standalone rebase command
 *  does — re-deriving it from the pending queue at merge-editor-open time would race the very
 *  ClearPending call that made this rebase happen in the first place. */
export type OpenMergeEditor = (origin: string, relativePath: string) => Thenable<unknown> | Promise<unknown>;

export interface ExternalChangeCoordinatorDeps {
  repository: PluginRepository;
  controller: SessionController;
  showDialog: ShowExternalChangeDialog;
  showRebaseOffer: ShowRebaseOffer;
  openMergeEditor: OpenMergeEditor;
  log?: (msg: string) => void;
}

/** How often the queue is polled for a new question — matches `SESSION_STATUS_POLL_INTERVAL_MS`'s
 *  order of magnitude but slower: an external change is rare and never latency-sensitive the way a
 *  running session load is, so there is no reason to poll at the same cadence. */
export const EXTERNAL_CHANGE_POLL_INTERVAL_MS = 3000;

/**
 * Starts polling `GET /plugins/external-changes/status`; whenever it reports one or more pending
 * questions, runs the one dialog for each (sequentially — {@link runExternalChangeDialogs} itself
 * enforces that) and dispatches every answer. Returns a stop function. Self-rescheduling
 * `setTimeout`, same idiom `SessionController`'s own pollers use, so a slow poll (or a slow dialog
 * a user leaves open) can never stack ticks behind itself.
 */
export function startExternalChangePolling(
  deps: ExternalChangeCoordinatorDeps, intervalMs = EXTERNAL_CHANGE_POLL_INTERVAL_MS,
): () => void {
  const log = deps.log ?? (() => {});
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async () => {
    try {
      const pending = await deps.repository.getExternalChangeStatus();
      if (!stopped && pending.length > 0) await handlePending(deps, pending);
    } catch (e) {
      // ADR-0026 background/recoverable tier: a poll blip gets a log line and the next tick, same
      // posture as every other poller in this codebase — never a toast for a transient failure to
      // ask "is anything pending".
      log(`[externalChangeCoordinator] poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  timer = setTimeout(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

async function handlePending(deps: ExternalChangeCoordinatorDeps, pending: PendingExternalChange[]): Promise<void> {
  const outcomes = await runExternalChangeDialogs(pending, deps.showDialog);
  for (const { pending: item, answer } of outcomes) {
    // Sequential, deliberately: two dispatches for the same repo racing (e.g. two plugins in one
    // mod folder both queued) must not overlap a rebase offer against an absorb still in flight.
    await dispatchOne(deps, item, answer);
  }
}

async function dispatchOne(
  deps: ExternalChangeCoordinatorDeps, item: PendingExternalChange, answer: ExternalChangeDialogAnswer,
): Promise<void> {
  // 'defer' (Esc/dismiss): exit path 3 — nothing is written, nothing is called; the question
  // re-asks at the next poll tick exactly because the backend's own queue still holds it.
  if (answer === 'defer') return;

  if (answer === 'keep') {
    await deps.controller.keepAsMyEdit(item.plugin, item.origin);
    return;
  }

  const result = await deps.controller.absorbUpstreamUpdate(item.plugin, item.origin);
  if (!result?.succeeded) return;

  const choice = await deps.showRebaseOffer(rebaseOfferMessage(item.origin), REBASE_NOW_BUTTON, REBASE_LATER_BUTTON);
  if (choice !== REBASE_NOW_BUTTON) return; // 'Later' — the branch stays honestly behind main.

  await runRebase(deps, item.origin);
}

/** Shared by the follow-up notification's "Rebase Now" and the standalone
 *  `Modbench: Rebase onto Updated Baseline` command — a clean rebase needs nothing further; a
 *  conflicted one opens every conflicted path in the native merge editor. */
export async function runRebase(deps: Pick<ExternalChangeCoordinatorDeps, 'controller' | 'openMergeEditor'>, origin: string): Promise<RebaseResult | null> {
  const result = await deps.controller.rebaseOntoMain(origin);
  if (result?.outcome === 'Conflicted') {
    for (const path of result.conflictedPaths) {
      await deps.openMergeEditor(origin, path);
    }
  }
  return result;
}
