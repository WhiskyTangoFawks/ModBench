// Refresh ends with the Instance loader reading every file again and calls no view's own refresh:
// the Mods tree picks the new value up through its own subscription.

import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

import { Instance } from '../../instanceLoader/instance';
import { ModListProvider, ModNode } from '../ModListProvider';
import { resolvesNotFound } from '../../test/mo2/gameFolderNotFound';
import { downloadsDirectoryResolver } from '../../instanceAdapter/downloadsDirectory';

async function setup() {
  const root = await cloneCorpusFixture();
  const instance = new Instance({
    instanceRoot: root,
    resolveGameDirectory: resolvesNotFound,
    resolveDownloadsDirectory: downloadsDirectoryResolver(),
    log: () => {},
    logReadFailure: () => {},
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

describe('an Instance re-read reaches the Mods tree', () => {
  it('rival: the view\'s own invalidate() leaves the tree stale after a disk change the watcher has not delivered', async () => {
    const { root, provider } = await setup();
    await addModOnDisk(root);

    provider.invalidate();

    expect(hasNewMod(await provider.getChildren())).toBe(false);
  });

  it('the Instance loader reading every file again reaches the tree with no view refresh', async () => {
    const { root, instance, provider } = await setup();
    await addModOnDisk(root);

    await instance.refresh();

    expect(hasNewMod(await provider.getChildren())).toBe(true);
  });
});
