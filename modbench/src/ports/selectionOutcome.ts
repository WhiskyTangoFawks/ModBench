/** One item of a selection that wrote nothing, and why. */
export interface ItemRefusal<T> { item: T; reason: string }

/** A command's result over a selection (ADR-0019; commands.md, A selection is one gesture, and
 *  each item lands on its own). */
export interface SelectionOutcome<T> {
  landed: readonly T[];
  refused: readonly ItemRefusal<T>[];
}

/** A gesture over a selection, in one write: each item landed or refused by name, or the whole
 *  selection refused once. */
export type SelectionResult<T> =
  | { applied: true; outcome: SelectionOutcome<T> }
  | { applied: false; refusal: string };
