import { describe, it, expect, vi, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Mod, ModGroups, Separator } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { instanceOnDisk } from './instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true, updateAvailable: false });
const sep = (name: string): Separator => ({ kind: 'separator', name, enabled: false });

describe('a separator\'s group in the mod order', () => {
  let instance: string;
  afterEach(() => rm(instance, { recursive: true, force: true }));

  it.each<{ name: string; modlist: string; grouped: ModGroups }>([
    {
      name: 'an order with no separator leaves every mod ungrouped',
      modlist: '+A\n+B',
      grouped: { groups: [], ungrouped: [mod('A'), mod('B')] },
    },
    {
      name: 'a separator holds the mods before it, and a mod after the last separator is ungrouped',
      modlist: '+A\n+B\n-S1_separator\n+C',
      grouped: { groups: [{ separator: sep('S1'), mods: [mod('A'), mod('B')] }], ungrouped: [mod('C')] },
    },
    {
      name: 'a separator holds the mods back to the separator before it, the first one first an empty group',
      modlist: '-S1_separator\n+A\n+B\n-S2_separator\n+C',
      grouped: {
        groups: [{ separator: sep('S1'), mods: [] }, { separator: sep('S2'), mods: [mod('A'), mod('B')] }],
        ungrouped: [mod('C')],
      },
    },
    {
      name: 'two separators in a row are two empty groups',
      modlist: '-Empty_separator\n-S2_separator\n+A',
      grouped: { groups: [{ separator: sep('Empty'), mods: [] }, { separator: sep('S2'), mods: [] }], ungrouped: [mod('A')] },
    },
    {
      name: 'a separator last leaves no mod ungrouped',
      modlist: '+A\n+B\n-S1_separator\n+C\n+D\n-S2_separator',
      grouped: {
        groups: [{ separator: sep('S1'), mods: [mod('A'), mod('B')] }, { separator: sep('S2'), mods: [mod('C'), mod('D')] }],
        ungrouped: [],
      },
    },
  ])('$name', async ({ modlist, grouped }) => {
    instance = await instanceOnDisk({ 'profiles/Default/modlist.txt': modlist });

    expect((await adapterOver(instance).reading()).modGroups).toEqual(grouped);
  });
});
