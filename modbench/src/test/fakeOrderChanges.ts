import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import {
  entryNotFound, type EntryRef, type ModlistEntry, type ModOrderChange, type MovePlace, type OrderEnd, type PluginEntry, type PluginOrderChange,
  type SeparatorsPlace,
} from '../instanceAdapter/instanceAdapter';

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const indexOfEntry = (order: readonly ModlistEntry[], entry: EntryRef): number =>
  order.findIndex((listed) => listed.kind === entry.kind && sameName(listed.name, entry.name));

function listedName(order: readonly ModlistEntry[], entry: EntryRef): string {
  const listed = order[indexOfEntry(order, entry)];
  if (listed === undefined) throw new Error(entryNotFound(entry));
  return listed.name;
}

const isListed = (order: readonly ModlistEntry[], entry: EntryRef): boolean => indexOfEntry(order, entry) !== -1;

function requireUnlisted(order: readonly ModlistEntry[], separator: string): void {
  if (isListed(order, { kind: 'separator', name: separator })) throw new Error(`Separator already in modlist: ${separator}`);
}

function alreadyDone(order: readonly ModlistEntry[], change: ModOrderChange): boolean {
  switch (change.kind) {
    case 'addAtWinningEnd': return isListed(order, change.entry);
    case 'dropMod': return !isListed(order, { kind: 'mod', name: change.mod });
    case 'renameMod': return !isListed(order, { kind: 'mod', name: change.from });
    case 'dropSeparator': return !isListed(order, { kind: 'separator', name: change.separator });
    case 'enable':
    case 'moveMods':
    case 'moveSeparators':
    case 'addSeparator':
    case 'renameSeparator':
      return false;
  }
}

function resolved(order: readonly ModlistEntry[], change: ModOrderChange): ModOrderChange {
  const mod = (name: string): string => listedName(order, { kind: 'mod', name });
  const separator = (name: string): string => listedName(order, { kind: 'separator', name });
  const separatorsPlace = (place: SeparatorsPlace): SeparatorsPlace => (place.kind === 'separator' ? { kind: 'separator', name: separator(place.name) } : place);
  const movePlace = (place: MovePlace): MovePlace =>
    (place.kind === 'mod' ? { kind: 'mod', name: mod(place.name) } : place.kind === 'ungrouped' ? place : separatorsPlace(place));
  switch (change.kind) {
    case 'enable': return { ...change, mod: mod(change.mod) };
    case 'moveMods': return { ...change, mods: change.mods.map(mod), place: movePlace(change.place) };
    case 'moveSeparators': return { ...change, separators: change.separators.map(separator), place: separatorsPlace(change.place) };
    case 'addAtWinningEnd': return change;
    case 'addSeparator':
      requireUnlisted(order, change.separator);
      return { ...change, anchor: { kind: change.anchor.kind, name: listedName(order, change.anchor) } };
    case 'renameSeparator': {
      const from = separator(change.from);
      if (!sameName(from, change.to)) requireUnlisted(order, change.to);
      return { ...change, from };
    }
    case 'renameMod': {
      const from = mod(change.from);
      if (isListed(order, { kind: 'mod', name: change.to }) && !sameName(from, change.to)) throw new Error(`Mod already in modlist: ${change.to}`);
      return { ...change, from };
    }
    case 'dropMod': return { ...change, mod: mod(change.mod) };
    case 'dropSeparator': return { ...change, separator: separator(change.separator) };
  }
}

const blockStartOf = (order: readonly ModlistEntry[], separatorAt: number): number =>
  order.slice(0, separatorAt).findLastIndex((entry) => entry.kind === 'separator') + 1;
const ungroupedWinningEnd = (order: readonly ModlistEntry[]): number => order.findLastIndex((entry) => entry.kind === 'separator') + 1;
const separatorAt = (order: readonly ModlistEntry[], name: string): number => indexOfEntry(order, { kind: 'separator', name });

function modsInsertAt(rest: readonly ModlistEntry[], place: MovePlace, end: OrderEnd): number {
  const losing = end === 'losing';
  switch (place.kind) {
    case 'ungrouped': return losing ? rest.length : ungroupedWinningEnd(rest);
    case 'separator': return losing ? separatorAt(rest, place.name) : blockStartOf(rest, separatorAt(rest, place.name));
    case 'mod': return indexOfEntry(rest, { kind: 'mod', name: place.name }) + (losing ? 1 : 0);
    case 'modOrder': return losing ? rest.length : 0;
  }
}

function separatorsInsertAt(rest: readonly ModlistEntry[], place: SeparatorsPlace, end: OrderEnd): number {
  const losing = end === 'losing';
  if (place.kind === 'modOrder') return losing ? ungroupedWinningEnd(rest) : 0;
  return losing ? separatorAt(rest, place.name) + 1 : blockStartOf(rest, separatorAt(rest, place.name));
}

function moveBlock(order: readonly ModlistEntry[], isMoved: (entry: ModlistEntry, index: number) => boolean, at: (rest: readonly ModlistEntry[]) => number): ModlistEntry[] {
  const rest = order.filter((entry, index) => !isMoved(entry, index));
  rest.splice(at(rest), 0, ...order.filter(isMoved));
  return rest;
}

function applied(order: readonly ModlistEntry[], change: ModOrderChange): ModlistEntry[] {
  switch (change.kind) {
    case 'enable': return order.map((entry) => (entry.kind === 'mod' && sameName(entry.name, change.mod) ? { ...entry, enabled: change.enabled } : entry));
    case 'moveMods': {
      const moved = (entry: ModlistEntry): boolean => entry.kind === 'mod' && change.mods.some((name) => sameName(name, entry.name));
      return moveBlock(order, moved, (rest) => modsInsertAt(rest, change.place, change.end));
    }
    case 'moveSeparators': {
      const inBlock = new Set(order.flatMap((entry, index) => (entry.kind === 'separator' && change.separators.some((name) => sameName(name, entry.name))
        ? Array.from({ length: index + 1 - blockStartOf(order, index) }, (_, offset) => blockStartOf(order, index) + offset)
        : [])));
      return moveBlock(order, (_, index) => inBlock.has(index), (rest) => separatorsInsertAt(rest, change.place, change.end));
    }
    case 'addAtWinningEnd': return [{ kind: change.entry.kind, name: change.entry.name, enabled: false }, ...order];
    case 'addSeparator': {
      const anchorAt = indexOfEntry(order, change.anchor);
      const at = change.anchor.kind === 'mod' ? anchorAt + 1 : blockStartOf(order, anchorAt);
      return order.toSpliced(at, 0, { kind: 'separator', name: change.separator, enabled: true });
    }
    case 'renameSeparator': return order.map((entry) => (entry.kind === 'separator' && sameName(entry.name, change.from) ? { ...entry, name: change.to } : entry));
    case 'renameMod': return order.map((entry) => (entry.kind === 'mod' && sameName(entry.name, change.from) ? { ...entry, name: change.to } : entry));
    case 'dropMod': return order.filter((entry) => !(entry.kind === 'mod' && sameName(entry.name, change.mod)));
    case 'dropSeparator': return order.filter((entry) => !(entry.kind === 'separator' && sameName(entry.name, change.separator)));
  }
}

/** The order the changes leave, and each change that landed as the order lists its names. A change
 *  that is already done does not land; one that cannot land rejects them all. */
export function modOrderAfter(order: readonly ModlistEntry[], changes: readonly ModOrderChange[]): { order: ModlistEntry[]; landed: ModOrderChange[] } {
  let after = [...order];
  const landed: ModOrderChange[] = [];
  for (const change of changes) {
    if (alreadyDone(after, change)) continue;
    const landing = resolved(after, change);
    landed.push(landing);
    after = applied(after, landing);
  }
  return { order: after, landed };
}

const pluginAt = (order: readonly PluginEntry[], plugin: string): number => order.findIndex((listed) => pluginKey(listed.name) === pluginKey(plugin));

function listedPlugin(order: readonly PluginEntry[], plugin: string): PluginEntry {
  const listed = order[pluginAt(order, plugin)];
  if (listed === undefined) throw new Error(`Plugin not found in plugins.txt: ${plugin}`);
  return listed;
}

function appliedToPlugins(order: readonly PluginEntry[], change: PluginOrderChange): PluginEntry[] {
  switch (change.kind) {
    case 'enable': {
      const { name } = listedPlugin(order, change.plugin);
      return order.map((listed) => (listed.name === name ? { ...listed, enabled: change.enabled } : listed));
    }
    case 'move': {
      const names = change.plugins.map((plugin) => listedPlugin(order, plugin).name);
      const rest = order.filter((listed) => !names.includes(listed.name));
      return rest.toSpliced(Math.min(Math.max(0, change.toIndex), rest.length), 0, ...order.filter((listed) => names.includes(listed.name)));
    }
    case 'add': return pluginAt(order, change.plugin) === -1 ? [...order, { name: change.plugin, enabled: false }] : [...order];
    case 'drop': {
      const { name } = listedPlugin(order, change.plugin);
      return order.filter((listed) => listed.name !== name);
    }
  }
}

/** The order the changes leave; a plugin that is not listed rejects them all. */
export const pluginOrderAfter = (order: readonly PluginEntry[], changes: readonly PluginOrderChange[]): PluginEntry[] =>
  changes.reduce(appliedToPlugins, [...order]);
