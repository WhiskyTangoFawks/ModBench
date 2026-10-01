import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CONFLICT_COLOURS } from './gridStyles';

interface ColourEntry { id: string; defaults: Record<string, string> }

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { contributes: { colors: ColourEntry[] } };

describe('conflict theme colours', () => {
  it('the manifest contributes each colour the panel paints with, and no other conflict colour', () => {
    const contributed = manifest.contributes.colors.map(c => c.id).filter(id => id.startsWith('modbench.conflict.'));
    expect(contributed.sort()).toEqual(Object.values(CONFLICT_COLOURS).sort());
  });

  it('each has a default for every kind of theme', () => {
    for (const colour of manifest.contributes.colors) {
      expect(Object.keys(colour.defaults).sort(), colour.id)
        .toEqual(['dark', 'highContrast', 'highContrastLight', 'light']);
    }
  });
});
