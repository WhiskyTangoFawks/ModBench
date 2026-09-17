import { describe, it, expect, vi } from 'vitest';
import { present } from '../../ports/present';
import { watchers, fakeVscodeModule } from '../../modmanager/test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createModlistWatcher } from '../modlistWatcher';

describe('createModlistWatcher', () => {
  it('watches every profile\'s modlist.txt under the instance root', () => {
    watchers.length = 0;

    createModlistWatcher('/instance', () => {});

    // Every profile, not the active one: switching profiles changes which file matters, and a
    // path resolved once at registration would stop watching the moment it did.
    expect(present(watchers[0], 'the modlist watcher registered for the instance').pattern).toBe(
      'profiles/*/modlist.txt',
    );
  });
});
