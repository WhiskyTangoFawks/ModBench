import { describe, it, expect } from 'vitest';
import type { ModGroup } from '../../instanceLoader/instance';
import { groupSeparators, type SeparatorEntry } from '../separatorGroups';

const groupsOf = (...names: string[]): ModGroup[] => names.map((name) => ({ separator: { kind: 'separator', name, enabled: false }, mods: [] }));

const shape = (entries: readonly SeparatorEntry[]): unknown[] =>
  entries.map((entry) => (entry.kind === 'group' ? { [`${entry.path}#${entry.run}`]: shape(entry.children) } : entry.label));

describe('separators grouped by a prefix before " - "', () => {
  it.each<[string, string[], unknown[]]>([
    ['a lone separator keeps its full name', ['textures - Fixes'], ['textures - Fixes']],
    ['two consecutive separators that share a prefix sit under a group of it', ['textures - Fixes', 'textures - Retextures'], [{ 'textures#1': ['Fixes', 'Retextures'] }]],
    ['a separator between them keeps them apart', ['a - x', 'Plain', 'a - y'], ['a - x', 'Plain', 'a - y']],
    ['the rule recurs on the names less their prefix', ['a - b - c', 'a - b - d', 'a - e'], [{ 'a#1': [{ 'a - b#1': ['c', 'd'] }, 'e'] }]],
    ['a name with nothing before or after the divider has no prefix', [' - x', ' - y', 'z - ', 'z - '], [' - x', ' - y', 'z - ', 'z - ']],
    ['a second run of one prefix counts as the next run', ['a - x', 'a - y', 'Plain', 'a - z', 'a - w'], [{ 'a#1': ['x', 'y'] }, 'Plain', { 'a#2': ['z', 'w'] }]],
  ])('%s', (_name, names, expected) => {
    expect(shape(groupSeparators(groupsOf(...names)))).toEqual(expected);
  });
});
