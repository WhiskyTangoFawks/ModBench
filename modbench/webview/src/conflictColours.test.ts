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

const CONFLICT_ALL: ConflictAll[] = ['OnlyOne', 'NoConflict', 'Override', 'Conflict'];
const CONFLICT_THIS: ConflictThis[] = ['OnlyOne', 'Master', 'IdenticalToMaster', 'Override', 'ConflictWins', 'ConflictLoses'];

describe('conflict theme colours', () => {
  it('every contributed colour id has at most one dot, since VS Code replaces only the first', () => {
    for (const { id } of contributedColours()) {
      expect(id.split('.').length - 1, id).toBeLessThanOrEqual(1);
    }
  });

  it('the panel paints exactly the conflict colours the manifest contributes, under the variable VS Code names each', () => {
    const vscodeVariables = contributedColours().filter(({ id }) => id.startsWith('modbench.conflict')).map(({ id }) => {
      const [namespace, ...rest] = id.split('.');
      return `var(--vscode-${namespace}-${rest.join('.')})`;
    });
    const painted = new Set<string>();
    for (const state of CONFLICT_ALL) {
      const background = rowBackground(state);
      if (background) painted.add(background);
    }
    for (const state of CONFLICT_THIS) {
      const { backgroundColor, color } = getCellStyle(state);
      for (const value of [backgroundColor, color]) if (typeof value === 'string') painted.add(value);
    }
    expect([...painted].sort()).toEqual(vscodeVariables.sort());
  });

  it('each has a default for every kind of theme', () => {
    for (const colour of contributedColours()) {
      expect(Object.keys(colour.defaults).sort(), colour.id)
        .toEqual(['dark', 'highContrast', 'highContrastLight', 'light']);
    }
  });
});
