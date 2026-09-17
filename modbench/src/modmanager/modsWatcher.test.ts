import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createModsWatcher } from './modsWatcher';
import { present } from '../ports/present';

describe('createModsWatcher', () => {
  it('watches mods/** under the instance root', () => {
    watchers.length = 0;

    createModsWatcher('/instance', () => {});

    expect(present(watchers[0], "the watcher registered for the instance root").pattern).toBe('mods/**');
  });
});
