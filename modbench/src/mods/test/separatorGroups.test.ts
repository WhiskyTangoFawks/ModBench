import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import { labelOf, modsViewOn } from './modsViewOn';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const separatorsShown = (...names: string[]) =>
  modsViewOn({ value: instanceValueFixture({ mods: names.map((name) => ({ kind: 'separator' as const, name, enabled: false })).reverse() }) });

async function shape(shown: ReturnType<typeof modsViewOn>, parent?: vscode.TreeItem): Promise<unknown[]> {
  const separators = (await shown.rows(parent)).filter(({ contextValue }) => contextValue?.startsWith('separator'));
  return Promise.all(separators.map(async (row) => (row.contextValue === 'separatorGroup' ? { [String(labelOf(row))]: await shape(shown, row) } : labelOf(row))));
}

describe('separators grouped by a prefix before " - "', () => {
  it.each<[string, string[], unknown[]]>([
    ['a lone separator keeps its full name', ['textures - Fixes'], ['textures - Fixes']],
    ['two consecutive separators that share a prefix sit under a group of it', ['textures - Fixes', 'textures - Retextures'], [{ textures: ['Fixes', 'Retextures'] }]],
    ['a separator between them keeps them apart', ['a - x', 'Plain', 'a - y'], ['a - x', 'Plain', 'a - y']],
    ['the rule recurs on the names less their prefix', ['a - b - c', 'a - b - d', 'a - e'], [{ a: [{ b: ['c', 'd'] }, 'e'] }]],
    ['a name with nothing before or after the divider has no prefix', [' - x', ' - y', 'z - ', 'z - '], [' - x', ' - y', 'z - ', 'z - ']],
    ['a second run of one prefix is a group of its own', ['a - x', 'a - y', 'Plain', 'a - z', 'a - w'], [{ a: ['x', 'y'] }, 'Plain', { a: ['z', 'w'] }]],
  ])('%s', async (_name, names, expected) => {
    expect(await shape(separatorsShown(...names))).toEqual(expected);
  });

  it('gives a second run of one prefix a row VS Code tells apart from the first', async () => {
    const { rows } = separatorsShown('a - x', 'a - y', 'Plain', 'a - z', 'a - w');

    const [first, , second] = await rows();

    expect(first?.id).not.toBe(second?.id);
  });
});
