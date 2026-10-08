import { describe, it, expect } from 'vitest';
import { modOfOrigin } from '../modOfOrigin';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';

describe('the mod an origin names', () => {
  const modDirs = new Map([['ModA', '/mods/ModA']]);

  it('is the mod as the instance spells it, whatever the origin\'s case', () => {
    expect(modOfOrigin(modDirs, 'moda')).toBe('ModA');
  });

  it('is none for Overwrite and the game\'s Data folder, which no mod folder carries', () => {
    expect(modOfOrigin(modDirs, 'Overwrite')).toBeUndefined();
    expect(modOfOrigin(modDirs, DATA_DIRECTORY_ORIGIN)).toBeUndefined();
  });
});
