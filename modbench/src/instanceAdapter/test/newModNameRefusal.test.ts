import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { newModNameRefusal, type InstanceAdapter } from '../instanceAdapter';
import { mo2InstanceAdapter } from '../mo2Instance';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';

describe('newModNameRefusal', () => {
  let root: string;
  let adapter: InstanceAdapter;

  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = mo2InstanceAdapter({ instanceRoot: root, gameDirectoryOverrides: () => ({}) });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names the collision and points at the Downloads view when a folder holds a mod of that name', async () => {
    expect(await newModNameRefusal(adapter, 'Harder VATS')).toBe(
      'A mod named "Harder VATS" already exists — install its next release from the Downloads view instead.');
  });

  // Rival: an exact match, which lets the prompt accept a name the create or the install then refuses.
  it('names the collision for a mod of that name in another case, in the name as given', async () => {
    expect(await newModNameRefusal(adapter, 'harder vats')).toMatch(/"harder vats" already exists/);
  });

  // The manager knows a mod by its folder's name, and this one is a separator's. Rival: asking for
  // a mod of that name, which reads it as free.
  it('names the collision for a name a separator\'s folder has', async () => {
    expect(await newModNameRefusal(adapter, 'Unassigned (Modlist Development)_separator')).toMatch(/already exists/);
  });

  it('is silent for a free name, a separator\'s name, and a blank one', async () => {
    expect(await newModNameRefusal(adapter, 'A New Mod')).toBeUndefined();
    expect(await newModNameRefusal(adapter, 'Unassigned (Modlist Development)')).toBeUndefined();
    expect(await newModNameRefusal(adapter, '   ')).toBeUndefined();
  });

  it('checks the name trimmed', async () => {
    expect(await newModNameRefusal(adapter, '  Harder VATS ')).toMatch(/"Harder VATS" already exists/);
  });
});
