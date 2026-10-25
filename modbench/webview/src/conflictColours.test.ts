import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getCellStyle, rowBackground } from './gridStyles';
import type { ConflictAll, ConflictThis } from './types';

const manifest: unknown = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function contributedColours(): { id: string; defaults: Record<string, unknown> }[] {
  const colors = isRecord(manifest) && isRecord(manifest.contributes) ? manifest.contributes.colors : undefined;
  if (!Array.isArray(colors)) throw new Error('package.json contributes no colors');
  return colors.map((c: unknown) => {
    if (!isRecord(c) || typeof c.id !== 'string' || !isRecord(c.defaults)) throw new Error('malformed colour');
    return { id: c.id, defaults: c.defaults };
  });
}

const CONFLICT_ALL: ConflictAll[] = ['OnlyOne', 'NoConflict', 'Override', 'Conflict', 'ConflictBenign'];
const CONFLICT_THIS: ConflictThis[] = ['OnlyOne', 'Master', 'IdenticalToMaster', 'Override', 'ConflictWins', 'ConflictLoses'];

describe('conflict theme colours', () => {
  const ids = contributedColours().map(({ id }) => id);

  it.each(ids)('%s has at most one dot, since VS Code replaces only the first', id => {
    expect(id.split('.').length - 1).toBeLessThanOrEqual(1);
  });

  it('the panel paints exactly the conflict colours the manifest contributes, under the variable VS Code names each', () => {
    const vscodeVariables = ids.filter(id => id.startsWith('modbench.conflict')).map(id => {
      const [namespace, ...rest] = id.split('.');
      return `var(--vscode-${namespace}-${rest.join('.')})`;
    });
    const painted = [
      ...CONFLICT_ALL.map(rowBackground),
      ...CONFLICT_THIS.flatMap(state => [getCellStyle(state).backgroundColor, getCellStyle(state).color]),
    ].filter((value): value is string => typeof value === 'string');

    expect([...new Set(painted)].sort()).toEqual(vscodeVariables.sort());
  });

  it.each(contributedColours())('$id has a default for every kind of theme', ({ defaults }) => {
    expect(Object.keys(defaults).sort()).toEqual(['dark', 'highContrast', 'highContrastLight', 'light']);
  });
});
