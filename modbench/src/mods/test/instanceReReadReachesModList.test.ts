import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from '../../test/mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
}));

import { Instance } from '../../instanceLoader/instance';
import { ModListProvider, ModNode } from '../ModListProvider';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { accessTo, adapterOver, NO_DOWNLOADS, STEADY_WINDOW } from '../../test/mo2/adapterOver';

async function setup() {
  const root = cloneCorpusFixture();
  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: GAME_FOLDER_NOT_FOUND, downloadedFiles: NO_DOWNLOADS }),
    log: () => {},
    logReadFailure: () => {},
  });
  await instance.refresh();
  const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
  await populateTheCacheOffTheFirstValue(provider);
  return { root, instance, provider };
}

const populateTheCacheOffTheFirstValue = (provider: ModListProvider) => provider.getChildren();

async function appendRootModOnDiskBypassingTheWatcher(root: string): Promise<void> {
  const path = join(root, DEFAULT_MODLIST);
  const text = await readFile(path, 'utf8');
  await writeFile(path, `${text}+NewMod\r\n`);
}

const hasNewMod = (roots: unknown[]): boolean =>
  roots.some((n) => n instanceof ModNode && n.label === 'NewMod');

describe('an Instance re-read reaches the Mods tree', () => {
  it('rival: the view\'s own invalidate() leaves the tree stale after a disk change the watcher has not delivered', async () => {
    const { root, provider } = await setup();
    await appendRootModOnDiskBypassingTheWatcher(root);

    provider.invalidate();

    expect(hasNewMod(await provider.getChildren())).toBe(false);
  });

  it('the Instance loader reading every file again reaches the tree with no view refresh', async () => {
    const { root, instance, provider } = await setup();
    await appendRootModOnDiskBypassingTheWatcher(root);

    await instance.refresh();

    expect(hasNewMod(await provider.getChildren())).toBe(true);
  });
});
