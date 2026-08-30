import type { PluginRepository } from './PluginRepository';
import type { SessionController } from './SessionController';
import type { ExternalChangeDialogAnswer, ShowExternalChangeDialog } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import type { UnansweredExternalChange, RebaseResult } from './ApiClient';

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
 *  does — re-deriving it from the unanswered queue at merge-editor-open time would race the very
 *  MarkAnswered call that made this rebase happen in the first place. */
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
 * Starts polling `GET /plugins/external-changes/status`; whenever it reports one or more unanswered
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
      const unanswered = await deps.repository.getExternalChangeStatus();
      if (!stopped && unanswered.length > 0) await handleUnanswered(deps, unanswered);
    } catch (e) {
      // ADR-0026 background/recoverable tier: a poll blip gets a log line and the next tick, same
      // posture as every other poller in this codebase — never a toast for a transient failure to
      // ask "is anything unanswered".
      log(`[externalChangeCoordinator] poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  timer = setTimeout(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

export interface ExternalChangePollerGateDeps {
  /** Subscribe once, synchronously, to the backend's own lifecycle signal — the callback fires on
   *  every transition (BackendManager's 'status' event in production). */
  onBackendStatusChange: (cb: () => void) => void;
  /** Read fresh inside the callback, not cached — the emitted status string and `isHealthy` are
   *  two separate reads on the real `BackendManager`, and this only ever cares about the latter. */
  isBackendHealthy: () => boolean;
  /** Starts polling; returns its own stop function (same contract as {@link startExternalChangePolling}). */
  startPolling: () => () => void;
}

/**
 * #432: couples the external-change poller to the backend's actual process lifecycle instead of
 * extension activation — a backend that doesn't exist yet can never answer
 * `GET /plugins/external-changes/status`, so polling before one exists is pure noise (a permanent
 * `poll failed: fetch failed` line every tick, ADR-0026 background tier, but a call that can never
 * succeed).
 *
 * Gated on the backend's health signal alone, deliberately never on session load (the triage
 * comment's own binding call on #432): a backend that is up with no session loaded still answers
 * the endpoint normally, so the poller has no reason to wait for one. Starts on the first healthy
 * transition, never double-starts on a repeated one (e.g. a crash-restart's own second "attached"),
 * stops on any not-healthy transition (deliberate Close mEdit, a lost connection, or a restart
 * giving up), and starts fresh on the next healthy transition — a relaunch restarts it.
 */
export function gateExternalChangePolling(deps: ExternalChangePollerGateDeps): void {
  let stop: (() => void) | undefined;
  deps.onBackendStatusChange(() => {
    if (deps.isBackendHealthy()) {
      stop ??= deps.startPolling();
    } else {
      stop?.();
      stop = undefined;
    }
  });
}

async function handleUnanswered(deps: ExternalChangeCoordinatorDeps, unanswered: UnansweredExternalChange[]): Promise<void> {
  const outcomes = await runExternalChangeDialogs(unanswered, deps.showDialog);
  for (const { change: item, answer } of outcomes) {
    // Sequential, deliberately: two dispatches for the same repo racing (e.g. two plugins in one
    // mod folder both queued) must not overlap a rebase offer against an absorb still in flight.
    await dispatchOne(deps, item, answer);
  }
}

async function dispatchOne(
  deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange, answer: ExternalChangeDialogAnswer,
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
