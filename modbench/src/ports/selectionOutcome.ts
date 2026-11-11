/** One item of a selection that wrote nothing, and why. */
export interface ItemRefusal<T> { item: T; reason: string }

/** A command's result over a selection (ADR-0019; commands.md, A selection is one gesture, and
 *  each item lands on its own). */
export interface SelectionOutcome<T> {
  landed: readonly T[];
  refused: readonly ItemRefusal<T>[];
}
