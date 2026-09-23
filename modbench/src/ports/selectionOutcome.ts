/** One item of a selection that wrote nothing, and why. */
export interface ItemRefusal<T> { item: T; reason: string }

/** A command over a selection: each item lands on its own, so the result names the items that
 *  landed and each refused item with its reason (ADR-0019 invariant 4). */
export interface SelectionOutcome<T> {
  landed: readonly T[];
  refused: readonly ItemRefusal<T>[];
}
