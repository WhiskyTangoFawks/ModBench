import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createModsWatcher } from './modsWatcher';

describe('createModsWatcher', () => {
  it('watches mods/** under the instance root', () => {
    watchers.length = 0;

    createModsWatcher('/instance', () => {});

    expect(watchers[0].pattern).toBe('mods/**');
  });
});
