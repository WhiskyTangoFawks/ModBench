import type { UnansweredExternalChange } from '../medit/client';

/** Pinned UX contract: the two buttons, native cancel (Esc) always a third, unnamed option. */
export const ABSORB_BUTTON = 'Absorb Upstream Update';
export const KEEP_BUTTON = 'Keep as My Edit';

export type ExternalChangeDialogAnswer = 'absorb' | 'keep' | 'defer';

/** Button order carries the default — VS Code's modal focuses the first — never a separate flag:
 *  Absorb leads when the meta changed (ADR-0041). */
export function buttonsInDefaultOrder(change: UnansweredExternalChange): [string, string] {
  return change.metaChanged ? [ABSORB_BUTTON, KEEP_BUTTON] : [KEEP_BUTTON, ABSORB_BUTTON];
}

/** Evidence shown, not hidden, per the pinned contract. Keeps the single-plugin wording for a
 *  mod with exactly one changed plugin and no tracked file; names the mod and lists what changed
 *  otherwise. */
export function messageFor(change: UnansweredExternalChange): { message: string; detail: string } {
  const metaDetail = change.metaChanged
    ? `meta.ini also changed (version ${change.oldVersion ?? '?'} → ${change.newVersion ?? '?'})`
    : 'No matching meta.ini version change was observed.';

  if (change.plugins.length === 1 && change.trackedFiles.length === 0) {
    return { message: `${change.plugins[0]} (in ${change.origin}) changed outside Modbench.`, detail: metaDetail };
  }

  const parts: string[] = [];
  if (change.plugins.length > 0) parts.push(`plugin(s) ${change.plugins.join(', ')}`);
  if (change.trackedFiles.length > 0) parts.push(`tracked file(s) ${change.trackedFiles.join(', ')}`);
  return {
    message: `${change.origin} changed outside Modbench.`,
    detail: `Affected: ${parts.join(' and ')}. ${metaDetail}`,
  };
}

/** The one shape this module needs from `vscode.window.showWarningMessage` — injected so the
 *  sequencing below is testable without a VS Code host, same idiom `reporter.ts`/`backendLog.ts`
 *  already establish. */
export type ShowExternalChangeDialog = (
  message: string, options: { modal: true; detail: string }, ...buttons: string[]
) => Thenable<string | undefined> | Promise<string | undefined>;

export interface ExternalChangeDialogOutcome {
  change: UnansweredExternalChange;
  answer: ExternalChangeDialogAnswer;
}

/** One native modal per mod, shown sequentially — the notification is already one per mod, so no
 *  grouping step is needed here. */
export async function runExternalChangeDialogs(
  unanswered: readonly UnansweredExternalChange[],
  show: ShowExternalChangeDialog,
): Promise<ExternalChangeDialogOutcome[]> {
  const outcomes: ExternalChangeDialogOutcome[] = [];
  for (const change of unanswered) {
    const [first, second] = buttonsInDefaultOrder(change);
    const { message, detail } = messageFor(change);
    // Sequential by construction, deliberately not Promise.all'd: the pinned contract requires one
    // modal at a time, so the next mod's question must not be posed until this one settles.
    const choice = await show(message, { modal: true, detail }, first, second);
    outcomes.push({ change, answer: toAnswer(choice) });
  }
  return outcomes;
}

function toAnswer(choice: string | undefined): ExternalChangeDialogAnswer {
  if (choice === ABSORB_BUTTON) return 'absorb';
  if (choice === KEEP_BUTTON) return 'keep';
  return 'defer';
}
