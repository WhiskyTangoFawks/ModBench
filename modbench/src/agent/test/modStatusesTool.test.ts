import { describe, expect, it } from 'vitest';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { ModStatuses } from '../../modStatus/modStatuses';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { LIST_MOD_STATUSES } from '../modStatuses';

const gitGone: Pick<InstanceAdapter, 'modValue' | 'installationFile' | 'foldersHeldWhole' | 'filesHeldByGit' | 'filesIn'> = {
  filesIn: () => Promise.reject(new Error('never asked')),
  foldersHeldWhole: () => Promise.reject(new Error('git is gone')),
  filesHeldByGit: () => Promise.reject(new Error('git is gone')),
  modValue: () => Promise.reject(new Error('never asked')),
  installationFile: () => Promise.reject(new Error('never asked')),
};

describe('list_mod_statuses while git cannot say which folders it holds', () => {
  it('answers the reason on every mod at the first derive, never an empty list an agent would read as clean', async () => {
    const value = instanceValueFixture({
      holdsRepository: true, mods: [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'mod', name: 'ModB', enabled: true }],
      modFolders: [
        { kind: 'mod', name: 'ModA', path: '/i/mods/ModA', modName: 'ModA' }, { kind: 'mod', name: 'ModB', path: '/i/mods/ModB', modName: 'ModB' },
      ],
    });
    const statuses = new ModStatuses(gitGone, () => undefined);
    statuses.derive({ holdsRepository: true, mods: value.mods, modFolders: value.modFolders, entryKey: ({ name }) => name, paths: value.paths });

    expect(await LIST_MOD_STATUSES.of(value, statuses)).toEqual([{ mods: ['ModA', 'ModB'], unreadable: 'git could not say which folders it holds: git is gone' }]);
  });
});
