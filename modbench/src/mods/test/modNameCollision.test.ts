import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { collidingModName } from '../modNameCollision';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { accessTo } from '../../test/mo2/adapterOver';

describe('collidingModName', () => {
  let root: string;

  beforeEach(async () => {
    root = await cloneCorpusFixture();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names the collision and points at the Downloads view when a folder holds a mod of that name', async () => {
    const message = await collidingModName(accessTo(root), 'Harder VATS');
    expect(message).toMatch(/already exists/);
    expect(message).toMatch(/Downloads/);
  });

  // MO2 keys mods by name without case (modinfo.cpp, FileNameComparator). Rival: an exact match,
  // which lets the prompt accept a name the create then refuses.
  it('names the collision for a mod of that name in another case', async () => {
    expect(await collidingModName(accessTo(root), 'harder vats')).toMatch(/already exists/);
  });

  // MO2 knows a mod by its folder's name, and this one is a separator's. Rival: asking for a mod
  // of that name, which reads it as free.
  it('names the collision for a name a separator\'s folder has', async () => {
    expect(await collidingModName(accessTo(root), 'Unassigned (Modlist Development)_separator')).toMatch(/already exists/);
  });

  it('is silent for a name no folder holds', async () => {
    expect(await collidingModName(accessTo(root), 'A New Mod')).toBeUndefined();
  });

  it('ignores a separator of the same name — only a mod folder collides', async () => {
    expect(await collidingModName(accessTo(root), 'Unassigned (Modlist Development)')).toBeUndefined();
  });

  it('is silent for a blank name, leaving VS Code\'s own empty-input handling alone', async () => {
    expect(await collidingModName(accessTo(root), '   ')).toBeUndefined();
  });
});
