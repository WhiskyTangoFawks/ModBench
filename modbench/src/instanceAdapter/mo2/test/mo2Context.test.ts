import { describe, expect, it } from 'vitest';
import type { ModFolder } from '../../instanceAdapter';
import { modFoldersOf } from '../mo2Context';

describe('the mod folders MO2 matches an entry to', () => {
  const folder = (kind: ModFolder['kind'], name: string): ModFolder => ({ kind, name, path: `/mods/${name}`, modName: name });

  it('is the folder of the entry\'s kind and name, and else the one named alike without case', () => {
    const mod = folder('mod', 'Alpha');
    const folders = modFoldersOf([folder('separator', 'Alpha'), mod]);

    expect([folders.holding({ kind: 'mod', name: 'Alpha' }), folders.holding({ kind: 'mod', name: 'ALPHA' }), folders.holding({ kind: 'mod', name: 'Beta' })])
      .toEqual([mod, mod, undefined]);
  });
});
