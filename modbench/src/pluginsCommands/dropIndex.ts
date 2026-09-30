/** Where a drag landed, in a tree's own terms: the row it was dropped on and which side of it
 *  the block takes, or an end of the list. Which side a tree means is its view direction's. */
export type Drop =
  | { kind: 'before'; name: string }
  | { kind: 'after'; name: string }
  | { kind: 'winningEnd' }
  | { kind: 'losingEnd' };

// Where a block of dragged names lands once its own lines are gone: a drop names the
// *pre-removal* target, while every move counts its index among the lines that remain.
function indexAfterRemoval(order: readonly string[], movedNames: readonly string[], targetIndex: number): number {
  const moved = new Set(movedNames);
  return targetIndex - order.slice(0, targetIndex).filter((name) => moved.has(name)).length;
}

/** The index a splice writes the block at, in `plugins.txt`, whose last line wins. The losing end
 *  is index 0 whatever the list holds. Throws for a row the order does not list: the block has no
 *  place beside it. */
export function dropIndexIn(order: readonly string[], movedNames: readonly string[], drop: Drop): number {
  if (drop.kind === 'losingEnd') return 0;
  if (drop.kind === 'winningEnd') return indexAfterRemoval(order, movedNames, order.length);
  const target = order.indexOf(drop.name);
  if (target === -1) throw new Error(`Plugin not found in plugins.txt: ${drop.name}`);
  const at = indexAfterRemoval(order, movedNames, target);
  return drop.kind === 'before' ? at : at + 1;
}
