// mods.md, Drag and drop: a drop is `move`, and it lands where the view shows it.

import { pluralArgument } from '../drivingLib/gestureEntry';
import { endAtTop, type MoveTarget } from './movePick';
import type { ModlistNode, ModNode, SeparatorNode } from './ModListProvider';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import type { OrderEnd } from '../modCommands/modCommands';

/** The rows a drag carries, and the row whose kind a drag that mixes kinds takes. */
export interface DraggedRows {
  readonly rows: readonly (ModNode | SeparatorNode)[];
  readonly focused: ModNode | SeparatorNode;
}

/** The move a drop is: its Argument and its target. */
export interface Move {
  readonly argument: readonly (ModNode | SeparatorNode)[];
  readonly target: MoveTarget;
}

/** Why a drop cannot land. */
export interface Refusal {
  readonly refusal: string;
}

const otherEnd = (end: OrderEnd): OrderEnd => (end === 'winning' ? 'losing' : 'winning');

const nameOf = (row: ModNode | SeparatorNode): string => (row.kind === 'mod' ? row.mod.name : row.separator.name);

// The rows the view shows under a dragged separator travel with it, so a drop among them is a drop
// on the drag itself.
function dragRefusal(target: ModNode | SeparatorNode, rows: DraggedRows['rows']): string | undefined {
  if (rows.some((row) => row.id === target.id)) return `${nameOf(target)} is being dragged, so nothing goes onto it.`;
  if (target.kind !== 'mod') return undefined;
  const holder = rows.find((row) => row.kind === 'separator' && row.mods.some((m) => m.name === target.mod.name));
  return holder && `${nameOf(target)} is inside ${nameOf(holder)}, which is being dragged.`;
}

/** The move a drop makes, or why it cannot. Mods land at a separator's winning end, as move
 *  lands them; the rest land directly above the target, as shown. No target is below the last row. */
export function dropMove(dragged: DraggedRows, target: ModlistNode | undefined, direction: SortDirection): Move | Refusal {
  const argument = pluralArgument({ focused: dragged.focused, selection: dragged.rows }, 'mod', 'separator');
  const { kind } = dragged.focused;
  const end = endAtTop(direction);
  if (target === undefined) return { argument, target: { place: { kind: 'modOrder' }, end: otherEnd(end) } };
  if (target.kind === 'runtimeOutput') return { refusal: 'Overwrite is not a mod.' };
  if (target.kind !== 'mod' && target.kind !== 'separator') return { refusal: 'Nothing goes onto a file or a folder.' };
  const refusal = dragRefusal(target, dragged.rows);
  if (refusal !== undefined) return { refusal };
  if (target.kind === 'separator') {
    const place = { kind: 'separator', name: target.separator.name } as const;
    return { argument, target: { place, end: kind === 'mod' ? 'winning' : end } };
  }
  if (kind === 'separator') return { refusal: 'A separator goes above a separator, not on a mod.' };
  return { argument, target: { place: { kind: 'mod', name: target.mod.name }, end } };
}
