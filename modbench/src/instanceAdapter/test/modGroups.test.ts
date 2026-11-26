import { describe, it, expect, vi, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Mod, ModGroups, ModlistEntry, Separator } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { instanceOnDisk } from './instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true, updateAvailable: false });
const sep = (name: string): Separator => ({ kind: 'separator', name, enabled: false });

const modlistOf = (order: readonly ModlistEntry[]): string =>
  order.map((entry) => (entry.kind === 'mod' ? `+${entry.name}` : `-${entry.name}_separator`)).join('\n');

describe('a separator\'s group in the mod order', () => {
  let instance: string;
  afterEach(() => rm(instance, { recursive: true, force: true }));

  it.each<{ name: string; order: ModlistEntry[]; grouped: ModGroups }>([
    {
      name: 'an order with no separator leaves every mod ungrouped',
      order: [mod('A'), mod('B')],
      grouped: { groups: [], ungrouped: [mod('A'), mod('B')] },
    },
    {
      name: 'a separator holds the mods before it, and a mod after the last separator is ungrouped',
      order: [mod('A'), mod('B'), sep('S1'), mod('C')],
      grouped: { groups: [{ separator: sep('S1'), mods: [mod('A'), mod('B')] }], ungrouped: [mod('C')] },
    },
    {
      name: 'a separator holds the mods back to the separator before it, the first one first an empty group',
      order: [sep('S1'), mod('A'), mod('B'), sep('S2'), mod('C')],
      grouped: {
        groups: [{ separator: sep('S1'), mods: [] }, { separator: sep('S2'), mods: [mod('A'), mod('B')] }],
        ungrouped: [mod('C')],
      },
    },
    {
      name: 'two separators in a row are two empty groups',
      order: [sep('Empty'), sep('S2'), mod('A')],
      grouped: { groups: [{ separator: sep('Empty'), mods: [] }, { separator: sep('S2'), mods: [] }], ungrouped: [mod('A')] },
    },
    {
      name: 'a separator last leaves no mod ungrouped',
      order: [mod('A'), mod('B'), sep('S1'), mod('C'), mod('D'), sep('S2')],
      grouped: {
        groups: [{ separator: sep('S1'), mods: [mod('A'), mod('B')] }, { separator: sep('S2'), mods: [mod('C'), mod('D')] }],
        ungrouped: [],
      },
    },
  ])('$name', async ({ order, grouped }) => {
    instance = await instanceOnDisk({ 'profiles/Default/modlist.txt': modlistOf(order) });

    expect((await adapterOver(instance).reading()).modGroups).toEqual(grouped);
  });
});
