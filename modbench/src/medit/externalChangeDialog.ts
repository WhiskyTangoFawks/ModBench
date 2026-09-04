import type { UnansweredExternalChange } from './ApiClient';

/** Pinned UX contract: the two buttons, native cancel (Esc) always a third, unnamed option. */
export const ABSORB_BUTTON = 'Absorb Upstream Update';
export const KEEP_BUTTON = 'Keep as My Edit';

export type ExternalChangeDialogAnswer = 'absorb' | 'keep' | 'defer';

/** Every unanswered question sharing one origin — the repo, not the plugin, is the unit of
 *  baselines and rebase, and one repo's plugins answer together. */
export interface ExternalChangeRepoGroup {
  origin: string;
  items: readonly UnansweredExternalChange[];
}

/** Order-preserving (first-seen origin first), so the sequential dialog loop visits repos in the
 *  order the backend reported them. */
export function groupByOrigin(unanswered: readonly UnansweredExternalChange[]): ExternalChangeRepoGroup[] {
  const byOrigin = new Map<string, UnansweredExternalChange[]>();
  for (const item of unanswered) {
    const items = byOrigin.get(item.origin);
    if (items) items.push(item);
    else byOrigin.set(item.origin, [item]);
  }
  return [...byOrigin.entries()].map(([origin, items]) => ({ origin, items }));
}

/** Button order carries the default — VS Code's modal focuses the first — never a separate flag:
 *  Absorb leads when the meta changed (ADR-0041). Taken across the whole group, so Absorb leads
 *  when any plugin's meta changed. */
export function buttonsInDefaultOrder(group: ExternalChangeRepoGroup): [string, string] {
  const metaChanged = group.items.some((item) => item.metaChanged);
  return metaChanged ? [ABSORB_BUTTON, KEEP_BUTTON] : [KEEP_BUTTON, ABSORB_BUTTON];
}

/** Evidence shown, not hidden, per the pinned contract. Keeps the single-plugin wording for a
 *  repo with one changed plugin; names the repo and lists every plugin otherwise. */
export function messageFor(group: ExternalChangeRepoGroup): { message: string; detail: string } {
  const metaChanged = group.items.some((item) => item.metaChanged);
  // Evidence text: pulled from whichever item actually carries the tell (falling back to the
  // first) — in practice every item in a group agrees, since they share one meta.ini.
  const evidence = group.items.find((item) => item.metaChanged) ?? group.items[0];
  const metaDetail = metaChanged
    ? `meta.ini also changed (version ${evidence.oldVersion ?? '?'} → ${evidence.newVersion ?? '?'})`
    : 'No matching meta.ini version change was observed.';

  if (group.items.length === 1) {
    return { message: `${group.items[0].plugin} (in ${group.origin}) changed outside Modbench.`, detail: metaDetail };
  }

  const names = group.items.map((item) => item.plugin).join(', ');
  return {
    message: `${group.origin} changed outside Modbench.`,
    detail: `Affected plugins: ${names}. ${metaDetail}`,
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

/** One native modal per affected repo, shown sequentially, never one per plugin. Esc answers
 *  `'defer'` for the whole group; the flat outcome list keeps each plugin's identity for the
 *  caller's per-plugin dispatch. */
export async function runExternalChangeDialogs(
  unanswered: readonly UnansweredExternalChange[],
  show: ShowExternalChangeDialog,
): Promise<ExternalChangeDialogOutcome[]> {
  const outcomes: ExternalChangeDialogOutcome[] = [];
  for (const group of groupByOrigin(unanswered)) {
    const [first, second] = buttonsInDefaultOrder(group);
    const { message, detail } = messageFor(group);
    // Sequential by construction, deliberately not Promise.all'd: the pinned contract requires one
    // modal at a time, so the next repo's question must not be posed until this one settles.
    const choice = await show(message, { modal: true, detail }, first, second);
    const answer = toAnswer(choice);
    for (const item of group.items) outcomes.push({ change: item, answer });
  }
  return outcomes;
}

function toAnswer(choice: string | undefined): ExternalChangeDialogAnswer {
  if (choice === ABSORB_BUTTON) return 'absorb';
  if (choice === KEEP_BUTTON) return 'keep';
  return 'defer';
}
