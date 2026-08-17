import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createModlistWatcher } from './modlistWatcher';

describe('createModlistWatcher', () => {
  it('watches every profile\'s modlist.txt under the instance root', () => {
    watchers.length = 0;

    createModlistWatcher('/instance', () => {});

    // Every profile, not the active one: switching profiles changes which file matters, and a
    // path resolved once at registration would stop watching the moment it did.
    expect(watchers[0].pattern).toBe('profiles/*/modlist.txt');
  });
});
