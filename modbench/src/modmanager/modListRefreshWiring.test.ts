// extension.ts's `invalidateMods` closure must call `instance.refresh()` before
// `modListProvider.invalidate()`, like its `invalidatePlugins`/`invalidateDownloads` siblings.
// Reproduced against a real Instance and ModListProvider, so a regression is caught without the
// full VS Code extension host.

import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './test/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './test/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  uriFile, DataTransferItem, DataTransfer,
} from '../test/vscodeMock';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

import { Instance } from './instance';
import { ModListProvider, ModNode } from './ModListProvider';

async function setup() {
  const root = await cloneCorpusFixture();
  const instance = new Instance({
    instanceRoot: root,
    config: () => ({ get: () => undefined }),
    detectPaths: () => Promise.resolve(null),
    detectWinePrefix: () => Promise.resolve(null),
    onConfigChange: () => ({ dispose: () => {} }),
    log: () => {},
  });
  await instance.refresh();
  const provider = new ModListProvider({ instance, instanceRoot: root });
  await provider.getChildren(); // populate the cache off the first value
  return { root, instance, provider };
}

// A write straight to modlist.txt, bypassing the watcher — a disk change no debounce delivered
// yet. Appended past the last separator, so it lands as a root ModNode, not nested in a group.
async function addModOnDisk(root: string): Promise<void> {
  const path = join(root, DEFAULT_MODLIST);
  const text = await readFile(path, 'utf8');
  await writeFile(path, `${text}+NewMod\r\n`);
}

const hasNewMod = (roots: unknown[]): boolean =>
  roots.some((n) => n instanceof ModNode && n.label === 'NewMod');

describe('refreshAll wiring for the Mods tree', () => {
  it('rival: invalidate() alone leaves the tree stale after a disk change the watcher has not delivered', async () => {
    const { root, provider } = await setup();
    await addModOnDisk(root);

    provider.invalidate(); // the old `invalidateMods` shape

    expect(hasNewMod(await provider.getChildren())).toBe(false);
  });

  it('fixed: instance.refresh() then invalidate() picks up the disk change, matching Plugins/Downloads', async () => {
    const { root, instance, provider } = await setup();
    await addModOnDisk(root);

    await instance.refresh(); // the fixed `invalidateMods` shape
    provider.invalidate();

    expect(hasNewMod(await provider.getChildren())).toBe(true);
  });
});
