// mods.md, Drag and drop: a drop is `move`, and it lands where the view shows it.

import { pluralArgument } from './gestureEntry';
import { endAtTop, type MoveTarget } from './movePick';
import type { ModlistNode, ModNode, SeparatorNode, SortDirection } from './ModListProvider';
import type { OrderEnd } from '../modlist/modlist';

/** The rows a drag carries, and the row whose kind a drag that mixes kinds takes. */
export interface DraggedRows {
  readonly rows: readonly (ModNode | SeparatorNode)[];
  readonly focused?: ModNode | SeparatorNode;
}

/** The move a drop is: its Argument and its target. */
export interface Move {
  readonly argument: readonly (ModNode | SeparatorNode)[];
  readonly target: MoveTarget;
}

const otherEnd = (end: OrderEnd): OrderEnd => (end === 'winning' ? 'losing' : 'winning');

// The rows the view shows under a dragged separator travel with it, so a drop among them is a drop
// on the drag itself.
function isDragged(target: ModNode | SeparatorNode, rows: DraggedRows['rows']): boolean {
  return rows.some((row) => row.id === target.id
    || (target.kind === 'mod' && row.kind === 'separator' && row.mods.some((m) => m.name === target.mod.name)));
}

/** The move a drop makes, or none where what is dragged cannot go: on Overwrite, on a row being
 *  dragged, inside a separator being dragged, or a separator on a mod. `undefined` is the drop
 *  below the last row. */
export function dropMove(dragged: DraggedRows, target: ModlistNode | undefined, direction: SortDirection): Move | undefined {
  const argument = pluralArgument({ focused: dragged.focused, selection: dragged.rows }, 'mod', 'separator');
  const kind = argument[0]?.kind;
  if (kind === undefined) return undefined;
  const end = endAtTop(direction);
  if (target === undefined) return { argument, target: { place: { kind: 'modOrder' }, end: otherEnd(end) } };
  if (target.kind !== 'mod' && target.kind !== 'separator') return undefined;
  if (isDragged(target, dragged.rows)) return undefined;
  if (target.kind === 'separator') return { argument, target: { place: { kind: 'separator', name: target.separator.name }, end } };
  if (kind === 'separator') return undefined;
  return { argument, target: { place: { kind: 'mod', name: target.mod.name }, end } };
}
