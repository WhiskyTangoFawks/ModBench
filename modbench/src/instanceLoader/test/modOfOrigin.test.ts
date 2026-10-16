import { describe, it, expect } from 'vitest';
import { modOfOrigin } from '../modOfOrigin';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
import type { EntryRef } from '../../instanceAdapter/instanceAdapter';

describe('the mod an origin names', () => {
  const mods = [{ kind: 'separator' as const, name: 'Weapons', enabled: true }, { kind: 'mod' as const, name: 'ModA', enabled: true }];
  const entryKey = ({ name }: EntryRef): string => name.toLowerCase();
  const value = { mods, entryKey };

  it('is the mod as the mod order spells it, as the adapter\'s entry key matches names', () => {
    expect(modOfOrigin(value, 'moda')).toBe('ModA');
  });

  it('is matched by the adapter\'s key and by nothing else', () => {
    expect(modOfOrigin({ mods, entryKey: ({ name }) => name }, 'moda')).toBeUndefined();
  });

  it('is none for a separator, which no origin names', () => {
    expect(modOfOrigin(value, 'weapons')).toBeUndefined();
  });

  it('is none for Overwrite and the game\'s Data folder, which no listed mod carries', () => {
    expect(modOfOrigin(value, 'Overwrite')).toBeUndefined();
    expect(modOfOrigin(value, DATA_DIRECTORY_ORIGIN)).toBeUndefined();
  });
});
