import type { ModGroup } from '../instanceLoader/instance';

const DIVIDER = ' - ';

export interface SeparatorLeaf {
  readonly kind: 'separator';
  readonly held: ModGroup;
  readonly label: string;
  readonly parent: SeparatorGroup | undefined;
}

export interface SeparatorGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly parent: SeparatorGroup | undefined;
  readonly children: SeparatorEntry[];
}

export type SeparatorEntry = SeparatorLeaf | SeparatorGroup;

interface Remaining {
  readonly held: ModGroup;
  readonly rest: string;
}

function prefixOf(name: string): string | undefined {
  const at = name.indexOf(DIVIDER);
  return at > 0 && name.length > at + DIVIDER.length ? name.slice(0, at) : undefined;
}

/** Separators in mod order, folded under a group wherever two or more consecutive ones share a prefix, at every level. */
export function groupSeparators(groups: readonly ModGroup[]): SeparatorEntry[] {
  const runsSeen = new Map<string, number>();
  const idOf = (path: string): string => {
    const run = (runsSeen.get(path) ?? 0) + 1;
    runsSeen.set(path, run);
    return run === 1 ? `separatorGroup:${path}` : `separatorGroup:${path}#${run}`;
  };

  const build = (items: readonly Remaining[], parent: SeparatorGroup | undefined, parentPath: string | undefined): SeparatorEntry[] => {
    const entries: SeparatorEntry[] = [];
    let at = 0;
    for (let item = items[at]; item !== undefined; item = items[at]) {
      const prefix = prefixOf(item.rest);
      const sharing = prefix === undefined ? -1 : items.slice(at + 1).findIndex((next) => prefixOf(next.rest) !== prefix);
      const end = prefix === undefined ? at + 1 : at + 1 + (sharing === -1 ? items.length - at - 1 : sharing);
      if (prefix !== undefined && end - at >= 2) {
        const path = parentPath === undefined ? prefix : `${parentPath}${DIVIDER}${prefix}`;
        const group: SeparatorGroup = { kind: 'group', id: idOf(path), label: prefix, parent, children: [] };
        const inside = items.slice(at, end).map(({ held, rest }) => ({ held, rest: rest.slice(prefix.length + DIVIDER.length) }));
        group.children.push(...build(inside, group, path));
        entries.push(group);
      } else {
        entries.push({ kind: 'separator', held: item.held, label: item.rest, parent });
      }
      at = end;
    }
    return entries;
  };

  return build(groups.map((held) => ({ held, rest: held.separator.name })), undefined, undefined);
}
