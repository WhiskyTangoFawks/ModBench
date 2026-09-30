import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { installNameRefusal } from '../install';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { accessTo } from '../../test/mo2/adapterOver';

describe('installNameRefusal', () => {
  let root: string;

  beforeEach(async () => {
    root = await cloneCorpusFixture();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  // Rival: an exact match, which lets the prompt accept a name the install then refuses.
  it('refuses a name a folder already holds a mod under, in any case', async () => {
    expect(await installNameRefusal(accessTo(root), 'harder vats')).toMatch(/"harder vats" already exists/);
  });

  it('is silent for a free name, a separator\'s name, and a blank one', async () => {
    expect(await installNameRefusal(accessTo(root), 'A New Mod')).toBeUndefined();
    expect(await installNameRefusal(accessTo(root), 'Unassigned (Modlist Development)')).toBeUndefined();
    expect(await installNameRefusal(accessTo(root), '  ')).toBeUndefined();
  });
});
