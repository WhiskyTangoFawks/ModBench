// Composition, against the committed mo2-instance-corpus fixture: proving switch profile touches
// only the settings and nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { switchProfile } from '../../instanceCommands/profile';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from './corpusFixture';
import { accessTo, readActiveProfile, readModlistEntries } from './adapterOver';

const INI = 'ModOrganizer.ini';

describe('profile corpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // Rival this catches: an implementation that copies or merges profile content
  // instead of repointing selected_profile — both profiles' modlist.txt/plugins.txt
  // must stay byte-identical across a switch.
  it('switchProfile repoints ModOrganizer.ini only, leaving every profile file untouched', async () => {
    const before = await snapshotTree(dir);
    await switchProfile(accessTo(dir), 'Secondary', ['Default', 'Secondary']);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([INI]));

    expect(await readActiveProfile(dir)).toBe('Secondary');
    expect((await readModlistEntries(dir, 'Secondary')).map((e) => e.name)).toEqual([
      'Unofficial Fallout 4 Patch',
      'Harder VATS',
    ]);
  });
});
