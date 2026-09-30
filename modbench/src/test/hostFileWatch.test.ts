import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { present } from '../ports/present';

vi.mock('vscode', () => fakeVscodeModule());

import { watchFilesInHost } from '../hostFileWatch';

afterEach(() => {
  watchers.length = 0;
});

describe('the host\'s file watcher', () => {
  it('watches the glob beneath the folder it is given', () => {
    watchFilesInHost('/instance', 'mods/**', () => undefined);

    expect(watchers.map((w) => [w.base, w.pattern])).toEqual([['/instance', 'mods/**']]);
  });

  // Rival: a watcher listening for one kind of event, so a deleted folder is never heard.
  it('hands on the path of every file created, changed or deleted', () => {
    const heard: string[] = [];
    watchFilesInHost('/instance', 'mods/**', (path) => heard.push(path));
    const watcher = present(watchers[0], 'the watcher armed');

    watcher.fireCreate('/instance/mods/A/new.esp');
    watcher.fireChange('/instance/mods/A/changed.esp');
    watcher.fireDelete('/instance/mods/A');

    expect(heard).toEqual(['/instance/mods/A/new.esp', '/instance/mods/A/changed.esp', '/instance/mods/A']);
  });

  it('stops watching once disposed', () => {
    watchFilesInHost('/instance', 'mods/**', () => undefined).dispose();

    expect(present(watchers[0], 'the watcher armed').disposed).toBe(true);
  });
});
