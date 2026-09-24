// mods.md, Pickers, Move: the places a move offers. vscode-free, so unit-testable.

import type { ModlistEntry } from '../instanceLoader/instance';
import type { ModsPlace, OrderEnd } from '../modlist/modlist';
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

/** The end of mod order the view shows at the top: "first" and "directly above", as shown, lie
 *  toward it. */
export const endAtTop = (direction: SortDirection): OrderEnd => (direction === 'winningAtTop' ? 'winning' : 'losing');

const CURRENT = { description: 'current' } as const;

/** "Ungrouped", then each separator as the view shows them. A place that holds a selected mod is
 *  marked current. */
export function modsMovePick(
  entries: readonly ModlistEntry[], direction: SortDirection, modNames: readonly string[],
): MovePickItem<ModsPlace>[] {
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
): MovePickItem<string>[] {
  return groupsInViewOrder(entries, direction)
    .filter((g) => !separatorNames.includes(g.separator.name))
    .map((g) => ({ label: g.separator.name, target: g.separator.name }));
}
