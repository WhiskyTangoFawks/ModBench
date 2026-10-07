import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { newModNameRefusal } from '../commandRefusals';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { mo2InstanceAdapter } from '../../instanceAdapter/mo2Instance';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';

describe('newModNameRefusal', () => {
  let root: string;
  let adapter: InstanceAdapter;

  beforeEach(() => {
    root = cloneCorpusFixture();
    adapter = mo2InstanceAdapter({ instanceRoot: root, gameDirectoryOverrides: () => ({}), gameDirectoryChanged: () => ({ dispose: () => {} }) });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names the collision and points at the Downloads view when a folder holds a mod of that name', async () => {
    expect(await newModNameRefusal(adapter, 'Harder VATS')).toBe(
      'A mod named "Harder VATS" already exists — install its next release from the Downloads view instead.');
  });

  it('names the collision for a mod of that name in another case, in the name as given, so the prompt does not accept a name the create or the install then refuses', async () => {
    expect(await newModNameRefusal(adapter, 'harder vats')).toMatch(/"harder vats" already exists/);
  });

  it('names the collision for a name a separator\'s folder has, the manager knowing a mod by its folder\'s name and this one being a separator\'s', async () => {
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
