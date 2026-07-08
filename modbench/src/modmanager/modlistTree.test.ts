import { describe, it, expect } from 'vitest';
import type { Mod, ModlistEntry, Separator } from './model';
import { groupModlist } from './modlistTree';

const mod = (name: string, enabled = true, extra: Partial<Mod> = {}): Mod => ({
  kind: 'mod',
  name,
  enabled,
  ...extra,
});
const sep = (name: string, enabled = false): Separator => ({ kind: 'separator', name, enabled });

describe('groupModlist', () => {
  it('puts mods before the first separator in ungrouped', () => {
    const entries: ModlistEntry[] = [mod('A'), mod('B'), sep('S1'), mod('C')];
    const tree = groupModlist(entries);
    expect(tree.ungrouped.map((m) => m.name)).toEqual(['A', 'B']);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].separator.name).toBe('S1');
    expect(tree.groups[0].mods.map((m) => m.name)).toEqual(['C']);
  });

  it('handles a modlist with no separators (all ungrouped)', () => {
    const tree = groupModlist([mod('A'), mod('B')]);
    expect(tree.ungrouped.map((m) => m.name)).toEqual(['A', 'B']);
    expect(tree.groups).toEqual([]);
  });

  it('assigns each separator the mods that follow it until the next separator', () => {
    const entries: ModlistEntry[] = [
      sep('S1'),
      mod('A'),
      mod('B'),
      sep('S2'),
      mod('C'),
    ];
    const tree = groupModlist(entries);
    expect(tree.ungrouped).toEqual([]);
    expect(tree.groups.map((g) => g.separator.name)).toEqual(['S1', 'S2']);
    expect(tree.groups[0].mods.map((m) => m.name)).toEqual(['A', 'B']);
    expect(tree.groups[1].mods.map((m) => m.name)).toEqual(['C']);
  });

  it('keeps an empty separator (no following mods) as a group with no mods', () => {
    const tree = groupModlist([sep('Empty'), sep('S2'), mod('A')]);
    expect(tree.groups[0]).toEqual({ separator: sep('Empty'), mods: [] });
    expect(tree.groups[1].mods.map((m) => m.name)).toEqual(['A']);
  });

  it('counts active (enabled mods) and installed (total mods), excluding separators', () => {
    const entries: ModlistEntry[] = [
      mod('A', true),
      mod('B', false),
      sep('S1', true),
      mod('C', true),
    ];
    const tree = groupModlist(entries);
    expect(tree.activeCount).toBe(2);
    expect(tree.installedCount).toBe(3);
  });
});
