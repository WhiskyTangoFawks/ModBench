import type { Message } from './phrase';

/** One item of a selection that wrote nothing, and why. */
export interface ItemRefusal<T, Reason extends Message = string> { item: T; reason: Reason }

/** A command's result over a selection (ADR-0019; commands.md, A selection is one gesture, and
 *  each item lands on its own). */
export interface SelectionOutcome<T, Reason extends Message = string> {
  landed: readonly T[];
  refused: readonly ItemRefusal<T, Reason>[];
}
