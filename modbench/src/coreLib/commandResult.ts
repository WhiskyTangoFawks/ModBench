import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

/** What every command returns: applied, or the one refusal the user is told. `wrote` is false when
 *  the gesture already held, so nothing was written and no watcher fires. `Landed` is what a
 *  command's applied arm carries. */
export type CommandResult<Landed extends object = { wrote: boolean }> =
  | ({ applied: true } & Landed)
  | { applied: false; refusal: string };

/** A gesture over a selection, in one write: each item landed or refused by name, or the whole
 *  selection refused once. */
export type SelectionResult<T> =
  | { applied: true; outcome: SelectionOutcome<T> }
  | { applied: false; refusal: string };

/** The loop every plural verb shares: `run` each item, gathering the landed and the refused.
 *  `toItem` builds the item a caller sees; a landed item is handed its own result. */
export async function selectionOutcomeOf<I, T, Landed extends object>(
  items: readonly I[],
  run: (item: I) => Promise<CommandResult<Landed>>,
  toItem: (item: I, landed?: Landed) => T,
): Promise<SelectionOutcome<T>> {
  const landed: T[] = [];
  const refused: ItemRefusal<T>[] = [];
  for (const item of items) {
    const result = await run(item);
    if (result.applied) landed.push(toItem(item, result));
    else refused.push({ item: toItem(item), reason: result.refusal });
  }
  return { landed, refused };
}
