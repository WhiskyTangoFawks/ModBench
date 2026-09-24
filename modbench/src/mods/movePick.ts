// mods.md, Pickers, Move: the places a move offers.

import type { ModlistEntry } from '../instanceLoader/instance';
import type { MovePlace, OrderEnd, SeparatorsPlace } from '../modlist/modlist';
import { groupModlist, type ModlistGroup } from './modlistTree';
import type { SortDirection } from './ModListProvider';

export interface MovePickItem<T> {
  readonly label: string;
  readonly description?: string;
  readonly target: T;
}

// modlist.txt runs winning first, so the view with losing at the top shows the groups reversed.
function groupsInViewOrder(entries: readonly ModlistEntry[], direction: SortDirection): ModlistGroup[] {
  const { groups } = groupModlist([...entries]);
  return direction === 'winningAtTop' ? groups : [...groups].reverse();
}

/** Where a move lands: a place, and the end of it the moved rows take. */
export interface MoveTarget {
  readonly place: MovePlace;
  readonly end: OrderEnd;
}

/** The end of mod order the view shows at the top: "first" and "directly above", as shown, lie
 *  toward it. */
export const endAtTop = (direction: SortDirection): OrderEnd => (direction === 'winningAtTop' ? 'winning' : 'losing');

const CURRENT = { description: 'current' } as const;

/** "Ungrouped", then each separator as the view shows them. A place that holds a selected mod is
 *  marked current. */
export function modsMovePick(
  entries: readonly ModlistEntry[], direction: SortDirection, modNames: readonly string[],
): MovePickItem<MovePlace>[] {
  const holdsSelected = (mods: readonly { name: string }[]) => mods.some((m) => modNames.includes(m.name));
  const { ungrouped } = groupModlist([...entries]);
  return [
    { label: 'Ungrouped', target: { kind: 'ungrouped' }, ...(holdsSelected(ungrouped) && CURRENT) },
    ...groupsInViewOrder(entries, direction).map((g) => ({
      label: g.separator.name,
      target: { kind: 'separator', name: g.separator.name } as const,
      ...(holdsSelected(g.mods) && CURRENT),
    })),
  ];
}

/** The separators other than the selected ones, as the view shows them. */
export function separatorsMovePick(
  entries: readonly ModlistEntry[], direction: SortDirection, separatorNames: readonly string[],
): MovePickItem<SeparatorsPlace>[] {
  return groupsInViewOrder(entries, direction)
    .filter((g) => !separatorNames.includes(g.separator.name))
    .map((g) => ({ label: g.separator.name, target: { kind: 'separator', name: g.separator.name } }));
}

export const isSeparatorsPlace = (place: MovePlace): place is SeparatorsPlace =>
  place.kind === 'separator' || place.kind === 'modOrder';

const isOrderEnd = (value: unknown): value is OrderEnd => value === 'winning' || value === 'losing';

function placeOf(value: unknown): MovePlace | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'ungrouped' || value.kind === 'modOrder') return { kind: value.kind };
  if (value.kind !== 'separator' && value.kind !== 'mod') return undefined;
  return 'name' in value && typeof value.name === 'string' ? { kind: value.kind, name: value.name } : undefined;
}

/** A move's target as the command registry hands it over, which types nothing. */
export function moveTargetOf(value: unknown): MoveTarget | undefined {
  if (typeof value !== 'object' || value === null || !('place' in value) || !('end' in value)) return undefined;
  const place = placeOf(value.place);
  return place && isOrderEnd(value.end) ? { place, end: value.end } : undefined;
}
