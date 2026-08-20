import type { PendingExternalChange } from './ApiClient';

/** #417 pinned UX contract: the two buttons, native cancel (Esc) always a third, unnamed option. */
export const ABSORB_BUTTON = 'Absorb Upstream Update';
export const KEEP_BUTTON = 'Keep as My Edit';

export type ExternalChangeDialogAnswer = 'absorb' | 'keep' | 'defer';

/**
 * The button array in **default order** for one pending question — button order carries the
 * default (VS Code's modal focuses/Enters the first), never a separate flag. The Meta-SHA256
 * compare (`metaChanged`, computed server-side, never acted on there — ADR-0041 amendment:
 * "trailers may inform defaults, never actions") decides which button leads: meta changed →
 * Absorb Upstream Update first; unchanged or no trailer at all (both collapse to `metaChanged ===
 * false` on the wire) → Keep as My Edit first. Both buttons are always present either way.
 */
export function buttonsInDefaultOrder(pending: PendingExternalChange): [string, string] {
  return pending.metaChanged ? [ABSORB_BUTTON, KEEP_BUTTON] : [KEEP_BUTTON, ABSORB_BUTTON];
}

/** The modal's message + detail text — evidence shown, not hidden, per the pinned contract. */
export function messageFor(pending: PendingExternalChange): { message: string; detail: string } {
  const message = `${pending.plugin} (in ${pending.origin}) changed outside Modbench.`;
  const detail = pending.metaChanged
    ? `meta.ini also changed (version ${pending.oldVersion ?? '?'} → ${pending.newVersion ?? '?'})`
    : 'No matching meta.ini version change was observed.';
  return { message, detail };
}

/** The one shape this module needs from `vscode.window.showWarningMessage` — injected so the
 *  sequencing below is testable without a VS Code host, same idiom `reporter.ts`/`backendLog.ts`
 *  already establish. */
export type ShowExternalChangeDialog = (
  message: string, options: { modal: true; detail: string }, ...buttons: string[]
) => Thenable<string | undefined> | Promise<string | undefined>;

export interface ExternalChangeDialogOutcome {
  pending: PendingExternalChange;
  answer: ExternalChangeDialogAnswer;
}

/**
 * #417's one dialog: one native modal **per affected mod repo**, shown **sequentially** — never a
 * mega-dialog, never two modals racing each other (the pinned contract's own words). Each item in
 * `pending` gets its own `showWarningMessage` call, awaited before the next one is shown; Esc/
 * dismiss (the resolved value matching neither button) answers `'defer'` — nothing is written,
 * consistent with exit path 3 (the caller must not call absorb/keep for a deferred item).
 */
export async function runExternalChangeDialogs(
  pending: readonly PendingExternalChange[],
  show: ShowExternalChangeDialog,
): Promise<ExternalChangeDialogOutcome[]> {
  const outcomes: ExternalChangeDialogOutcome[] = [];
  for (const item of pending) {
    const [first, second] = buttonsInDefaultOrder(item);
    const { message, detail } = messageFor(item);
    // Sequential by construction, deliberately not Promise.all'd: the pinned contract requires one
    // modal at a time, so the next question must not be posed until this one settles.
    const choice = await show(message, { modal: true, detail }, first, second);
    outcomes.push({ pending: item, answer: toAnswer(choice) });
  }
  return outcomes;
}

function toAnswer(choice: string | undefined): ExternalChangeDialogAnswer {
  if (choice === ABSORB_BUTTON) return 'absorb';
  if (choice === KEEP_BUTTON) return 'keep';
  return 'defer';
}
