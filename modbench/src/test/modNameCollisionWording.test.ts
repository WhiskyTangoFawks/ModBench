// mods.md, New empty mod: one wording for create and install. The two are sibling core boxes with
// no reference between them, so only a test that sees both can hold them to it.
import { describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createEmptyMod } from '../modlist/modlist';
import { modNameCollisionRefusal } from '../install/install';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { accessTo } from './mo2/adapterOver';

describe('a mod name that already exists', () => {
  // Rival: create's own ad hoc text, which read differently from install's refusal.
  it('is refused by create empty mod in the words install gives the same collision', async () => {
    const root = await cloneCorpusFixture();
    try {
      const outcome = await createEmptyMod(accessTo(root), 'Default', 'Harder VATS');

      expect(outcome).toEqual({ applied: false, refusal: modNameCollisionRefusal('Harder VATS') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
