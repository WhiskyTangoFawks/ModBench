import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { present } from '../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());

import { createPluginsTxtWatcher } from '../pluginsTxtWatcher';

describe('createPluginsTxtWatcher', () => {
  it('watches every profile\'s plugins.txt under the instance root', () => {
    watchers.length = 0;

    createPluginsTxtWatcher('/instance', () => {});

    // Every profile, not the active one: switching profiles changes which file matters, and a
    // path resolved once at registration would stop watching the moment it did.
    expect(present(watchers[0], 'the watcher registered for the instance root').pattern).toBe(
      'profiles/*/plugins.txt',
    );
  });
});
