import type { UnansweredExternalChange } from '../client';
import type { AskQuestion } from '../ports/dialog';

/** The glossary's Edit branch entry: the fixed branch name every Track creates, matching the
 *  backend's `SourceRepository.EditBranchName` — never derived per repository. */
export const EDIT_BRANCH_NAME = 'edit';

/** Pinned UX contract: the two buttons, native cancel (Esc) always a third, unnamed option. Each
 *  label states what it does to the repository. */
export const BASELINE_BUTTON = 'Commit to main as new baseline';
export const APPLY_BUTTON = `Apply to working tree on ${EDIT_BRANCH_NAME}`;

export type ExternalChangeDialogAnswer = 'absorb' | 'keep' | 'defer';

/** Button order carries the default — VS Code's modal focuses the first — never a separate flag:
 *  baseline leads when the tell (meta.ini's version move) fired (ADR-0003). */
export function buttonsInDefaultOrder(change: UnansweredExternalChange): [string, string] {
  return change.metaChanged ? [BASELINE_BUTTON, APPLY_BUTTON] : [APPLY_BUTTON, BASELINE_BUTTON];
}

/** Message is the mod name; detail lists changed plugins by name, changed tracked files by count
 *  and name, and the version movement when the tell fired, else a no-change line. Evidence shown,
 *  not hidden. */
export function messageFor(change: UnansweredExternalChange): { message: string; detail: string } {
  const lines: string[] = [];
  if (change.plugins.length > 0) lines.push(`Plugin(s) changed: ${change.plugins.join(', ')}`);
  if (change.trackedFiles.length > 0) {
    lines.push(`${change.trackedFiles.length} tracked file(s) changed: ${change.trackedFiles.join(', ')}`);
  }
  lines.push(
    change.metaChanged
      ? `meta.ini's version moved from ${change.oldVersion ?? '?'} to ${change.newVersion ?? '?'}.`
      : 'No version change was observed.',
  );
  return { message: change.origin, detail: lines.join('\n') };
}

export interface ExternalChangeDialogOutcome {
  change: UnansweredExternalChange;
  answer: ExternalChangeDialogAnswer;
}

/** One native modal per mod, shown sequentially — the notification is already one per mod, so no
 *  grouping step is needed here. */
export async function runExternalChangeDialogs(
  unanswered: readonly UnansweredExternalChange[],
  show: AskQuestion,
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
  if (choice === BASELINE_BUTTON) return 'absorb';
  if (choice === APPLY_BUTTON) return 'keep';
  return 'defer';
}
