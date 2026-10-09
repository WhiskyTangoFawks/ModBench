import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { instanceCommands } from '../../instanceCommands/instanceCommands';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from './corpusFixture';
import { adapterOver, readActiveProfile, readModlistEntries } from './adapterOver';

const INI = 'ModOrganizer.ini';

describe('profile corpus', () => {
  let dir: string;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('switchProfile repoints ModOrganizer.ini only, leaving every profile file untouched', async () => {
    const before = await snapshotTree(dir);
    await instanceCommands({ adapter: adapterOver(dir), client: new InMemoryMEditClient(), instanceRoot: dir }).switchProfile('Secondary', ['Default', 'Secondary']);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([INI]));

    expect(await readActiveProfile(dir)).toBe('Secondary');
    expect((await readModlistEntries(dir, 'Secondary')).map((e) => e.name)).toEqual([
      'Unofficial Fallout 4 Patch',
      'Harder VATS',
    ]);
  });
});
