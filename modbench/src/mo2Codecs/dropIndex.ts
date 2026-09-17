/** Where a drag landed, in a tree's own terms: the row it was dropped on and which side of it
 *  the block takes, or an end of the list. Which side a tree means is its view direction's. */
export type Drop =
  | { kind: 'before'; name: string }
  | { kind: 'after'; name: string }
  | { kind: 'winningEnd' }
  | { kind: 'losingEnd' };

/** Where a block of dragged names lands once its own lines are gone: a drop names the
 *  *pre-removal* target, while every splice counts its index among the lines that remain. An
 *  absent target is the losing end. */
export function dropIndexForMove(
  order: readonly string[],
  movedNames: readonly string[],
  targetName: string | undefined,
): number {
  const moved = new Set(movedNames);
  const found = targetName === undefined ? -1 : order.indexOf(targetName);
  const targetIndex = found < 0 ? order.length : found;
  let movedBefore = 0;
  for (const name of order.slice(0, targetIndex)) if (moved.has(name)) movedBefore++;
  return targetIndex - movedBefore;
}

/** The index a splice writes the block at. The winning end is index 0 whatever else the list
 *  holds, so it needs no reckoning against the order at all. */
export function dropIndexIn(order: readonly string[], movedNames: readonly string[], drop: Drop): number {
  if (drop.kind === 'winningEnd') return 0;
  if (drop.kind === 'losingEnd') return dropIndexForMove(order, movedNames, undefined);
  const at = dropIndexForMove(order, movedNames, drop.name);
  return drop.kind === 'before' ? at : at + 1;
}
