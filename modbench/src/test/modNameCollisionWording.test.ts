// mods.md, New empty mod: one wording for create and install. The two are sibling core boxes with
// no reference between them, so only a test that sees both can hold them to it.
import { describe, it, expect } from 'vitest';
import { createEmptyMod } from '../modlist/modlist';
import { modNameCollisionRefusal } from '../install/install';

describe('a mod name that already exists', () => {
  // Rival: create's own ad hoc text, which read differently from install's refusal.
  it('is refused by create empty mod in the words install gives the same collision', async () => {
    const outcome = await createEmptyMod('/an/instance', 'Default', 'Lineless Folder', ['Lineless Folder']);

    expect(outcome).toEqual({ applied: false, refusal: modNameCollisionRefusal('Lineless Folder') });
  });
});
