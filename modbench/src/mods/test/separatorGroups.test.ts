import { describe, it, expect } from 'vitest';
import type { ModGroup } from '../../instanceLoader/instance';
import { groupSeparators, type SeparatorEntry } from '../separatorGroups';

const groupsOf = (...names: string[]): ModGroup[] => names.map((name) => ({ separator: { kind: 'separator', name, enabled: false }, mods: [] }));

const shape = (entries: readonly SeparatorEntry[]): unknown[] =>
  entries.map((entry) => (entry.kind === 'group' ? { [entry.id]: shape(entry.children) } : entry.label));

describe('separators grouped by a prefix before " - "', () => {
  it('a lone separator keeps its full name', () => {
    expect(shape(groupSeparators(groupsOf('textures - Fixes')))).toEqual(['textures - Fixes']);
  });

  it('two consecutive separators that share a prefix sit under a group of it', () => {
    expect(shape(groupSeparators(groupsOf('textures - Fixes', 'textures - Retextures')))).toEqual([
      { 'separatorGroup:textures': ['Fixes', 'Retextures'] },
    ]);
  });

  it('a separator between them keeps them apart', () => {
    expect(shape(groupSeparators(groupsOf('a - x', 'Plain', 'a - y')))).toEqual(['a - x', 'Plain', 'a - y']);
  });

  it('the rule recurs on the names less their prefix', () => {
    expect(shape(groupSeparators(groupsOf('a - b - c', 'a - b - d', 'a - e')))).toEqual([
      { 'separatorGroup:a': [{ 'separatorGroup:a - b': ['c', 'd'] }, 'e'] },
    ]);
  });

  it('a name with nothing before or after the divider has no prefix', () => {
    expect(shape(groupSeparators(groupsOf(' - x', ' - y', 'z - ', 'z - ')))).toEqual([' - x', ' - y', 'z - ', 'z - ']);
  });

  it('two runs of one prefix get distinct ids', () => {
    const ids = groupSeparators(groupsOf('a - x', 'a - y', 'Plain', 'a - z', 'a - w')).flatMap((entry) => (entry.kind === 'group' ? [entry.id] : []));

    expect(new Set(ids).size).toBe(2);
  });

  it('an entry knows the group that holds it', () => {
    const [group] = groupSeparators(groupsOf('a - x', 'a - y'));

    expect(group?.kind === 'group' && group.children.every((child) => child.parent === group)).toBe(true);
  });
});
