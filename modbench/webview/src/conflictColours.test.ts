import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CONFLICT_COLOURS } from './gridStyles';

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

describe('conflict theme colours', () => {
  it('the manifest contributes each colour the panel paints with, and no other conflict colour', () => {
    const contributed = contributedColours().map(c => c.id).filter(id => id.startsWith('modbench.conflict.'));
    expect(contributed.sort()).toEqual([...CONFLICT_COLOURS].sort());
  });

  it('each has a default for every kind of theme', () => {
    for (const colour of contributedColours()) {
      expect(Object.keys(colour.defaults).sort(), colour.id)
        .toEqual(['dark', 'highContrast', 'highContrastLight', 'light']);
    }
  });
});
