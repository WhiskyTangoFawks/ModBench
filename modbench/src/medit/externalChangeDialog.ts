import type { UnansweredExternalChange } from './ApiClient';

/** #417 pinned UX contract: the two buttons, native cancel (Esc) always a third, unnamed option. */
export const ABSORB_BUTTON = 'Absorb Upstream Update';
export const KEEP_BUTTON = 'Keep as My Edit';

export type ExternalChangeDialogAnswer = 'absorb' | 'keep' | 'defer';

/** Every unanswered question sharing one mod folder — the pinned contract's own unit ("one native
 *  modal per affected mod **repo**... the repo is the unit of baselines and rebase"), never one
 *  per plugin: a mod folder can hold more than one plugin, and their questions answer together. */
export interface ExternalChangeRepoGroup {
  origin: string;
  items: readonly UnansweredExternalChange[];
}

/** Groups a flat unanswered-change list by `origin` — order-preserving (first-seen origin first), so the
 *  sequential dialog loop below visits repos in the order the backend reported them. */
export function groupByOrigin(unanswered: readonly UnansweredExternalChange[]): ExternalChangeRepoGroup[] {
  const byOrigin = new Map<string, UnansweredExternalChange[]>();
  for (const item of unanswered) {
    const items = byOrigin.get(item.origin);
    if (items) items.push(item);
    else byOrigin.set(item.origin, [item]);
  }
  return [...byOrigin.entries()].map(([origin, items]) => ({ origin, items }));
}

/**
 * The button array in **default order** for one repo's question — button order carries the
 * default (VS Code's modal focuses/Enters the first), never a separate flag. The Meta-SHA256
 * compare (`metaChanged`, computed server-side, never acted on there — ADR-0041 amendment:
 * "trailers may inform defaults, never actions") decides which button leads: meta changed →
 * Absorb Upstream Update first; unchanged or no trailer at all (both collapse to `metaChanged ===
 * false` on the wire) → Keep as My Edit first. Both buttons are always present either way.
 *
 * **One default per repo, not per plugin**: every plugin in one mod folder shares a single
 * `meta.ini`, so in practice every item in a group already agrees on `metaChanged` (both derive
 * from the same baseline commit's single `Meta-SHA256` trailer and the same on-disk file). This
 * takes the disjunction (`some`) across the group rather than trusting that agreement — if a
 * future source of per-plugin classification ever let them disagree, Absorb leads only when *any*
 * plugin's meta actually changed, never silently defaulting to Keep because one plugin's verdict
 * happened to be read first.
 */
export function buttonsInDefaultOrder(group: ExternalChangeRepoGroup): [string, string] {
  const metaChanged = group.items.some((item) => item.metaChanged);
  return metaChanged ? [ABSORB_BUTTON, KEEP_BUTTON] : [KEEP_BUTTON, ABSORB_BUTTON];
}

/** The modal's message + detail text — evidence shown, not hidden, per the pinned contract. Keeps
 *  the pinned single-plugin wording when the repo has exactly one changed plugin; names the repo
 *  and lists every changed plugin when it has more than one. */
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

/**
 * #417's one dialog: one native modal **per affected mod repo**, shown **sequentially** — never a
 * mega-dialog, never two modals racing each other (the pinned contract's own words), and never one
 * modal per plugin either — a mod folder can hold more than one plugin, and they answer the same
 * question together. Each {@link ExternalChangeRepoGroup} gets its own `showWarningMessage` call,
 * awaited before the next repo's is shown; Esc/dismiss (the resolved value matching neither
 * button) answers `'defer'` for every plugin in that group — nothing is written, consistent with
 * exit path 3 (the caller must not call absorb/keep for a deferred item). The returned outcome
 * list is flat, one entry per **plugin** (not per repo): every item in a group gets the same
 * answer, but each keeps its own identity for the caller's per-plugin dispatch (deferral markers
 * and the absorb/keep endpoints are both per-plugin, per the pinned contract).
 */
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
