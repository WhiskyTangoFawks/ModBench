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
  it('assigns a separator the mods that precede it, leaving trailing mods ungrouped', () => {
    const entries: ModlistEntry[] = [mod('A'), mod('B'), sep('S1'), mod('C')];
    const tree = groupModlist(entries);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].separator.name).toBe('S1');
    expect(tree.groups[0].mods.map((m) => m.name)).toEqual(['A', 'B']);
    expect(tree.ungrouped.map((m) => m.name)).toEqual(['C']);
  });

  it('handles a modlist with no separators (all ungrouped)', () => {
    const tree = groupModlist([mod('A'), mod('B')]);
    expect(tree.ungrouped.map((m) => m.name)).toEqual(['A', 'B']);
    expect(tree.groups).toEqual([]);
  });

  it('assigns each separator the mods that precede it, back to the previous separator', () => {
    const entries: ModlistEntry[] = [
      sep('S1'),
      mod('A'),
      mod('B'),
      sep('S2'),
      mod('C'),
    ];
    const tree = groupModlist(entries);
    expect(tree.groups.map((g) => g.separator.name)).toEqual(['S1', 'S2']);
    // Nothing precedes S1 (it's the first entry) → empty group.
    expect(tree.groups[0].mods).toEqual([]);
    // A and B precede S2, back to S1 → S2's members.
    expect(tree.groups[1].mods.map((m) => m.name)).toEqual(['A', 'B']);
    // C trails the last separator → ungrouped.
    expect(tree.ungrouped.map((m) => m.name)).toEqual(['C']);
  });

  it('keeps an empty separator (nothing preceding it back to the prior separator) as a group with no mods', () => {
    const tree = groupModlist([sep('Empty'), sep('S2'), mod('A')]);
    expect(tree.groups[0]).toEqual({ separator: sep('Empty'), mods: [] });
    // Nothing sits between Empty and S2 either.
    expect(tree.groups[1]).toEqual({ separator: sep('S2'), mods: [] });
    expect(tree.ungrouped.map((m) => m.name)).toEqual(['A']);
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

  // LitR shape (#107 acceptance criterion): 5 ENB mods precede ENB_separator, 2
  // Radfall mods precede Radfall-AIO separator — each separator must claim the
  // mods that precede it, not the mods that (wrongly, under the old rule) follow it.
  it('LitR shape: each separator claims the run of mods immediately preceding it', () => {
    const radfallMod1 = mod('RadfallMod1');
    const radfallMod2 = mod('RadfallMod2');
    const enBoost16k = mod('ENBoost16k');
    const enBoost12k = mod('ENBoost12k');
    const enBoost8k = mod('ENBoost8k');
    const trueSight = mod('TrueSight');
    const enbSeries = mod('ENBSeries');
    const entries: ModlistEntry[] = [
      radfallMod1,
      radfallMod2,
      sep('Radfall-AIO'),
      enBoost16k,
      enBoost12k,
      enBoost8k,
      trueSight,
      enbSeries,
      sep('ENB'),
    ];
    const tree = groupModlist(entries);
    expect(tree.groups).toHaveLength(2);
    expect(tree.groups[0].separator.name).toBe('Radfall-AIO');
    expect(tree.groups[0].mods).toEqual([radfallMod1, radfallMod2]);
    expect(tree.groups[1].separator.name).toBe('ENB');
    expect(tree.groups[1].mods).toEqual([enBoost16k, enBoost12k, enBoost8k, trueSight, enbSeries]);
    expect(tree.ungrouped).toEqual([]);
  });
});
