import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  uriFile, DataTransferItem, DataTransfer,
} from './vscodeMock';

// A mod or a download landing on disk is a row change with no keystroke. Real Instance and
// provider, over the shared corpus fixture; only the InputBox and TreeView are doubles.

const h = vi.hoisted(() => {
  class FakeInputBox {
    value = '';
    placeholder = '';
    buttons: { iconPath: unknown; tooltip: string }[] = [];
    private changeHandlers: ((v: string) => void)[] = [];
    onDidChangeValue(cb: (v: string) => void) { this.changeHandlers.push(cb); return { dispose() { /* no-op */ } }; }
    onDidHide() { return { dispose() { /* no-op */ } }; }
    onDidTriggerButton() { return { dispose() { /* no-op */ } }; }
    show() { /* no-op */ }
    dispose() { /* no-op */ }
    type(text: string) { this.value = text; this.changeHandlers.forEach((cb) => cb(text)); }
  }
  const state = {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    boxes: [] as FakeInputBox[],
    trees: new Map<string, { description?: string; message?: string }>(),
  };
  return { FakeInputBox, state };
});

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
  window: {
    createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
      const view = { ...options, description: undefined, message: undefined };
      h.state.trees.set(id, view);
      return view;
    },
    createInputBox: () => {
      const box = new h.FakeInputBox();
      h.state.boxes.push(box);
      return box;
    },
    registerFileDecorationProvider: () => ({ dispose() { /* no-op */ } }),
  },
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
      h.state.commands.set(id, cb);
      return { dispose: () => h.state.commands.delete(id) };
    },
    executeCommand: () => Promise.resolve(),
  },
}));

import { Instance } from '../instanceLoader/instance';
import { ModListProvider } from '../mods/ModListProvider';
import { createModListView, registerDownloadsView } from '../mo2TreeViews';
import { present } from '../ports/present';
import { recordingReporter } from './surfacingDoubles';

const own = <T extends { dispose: () => void }>(d: T): T => d;

const command = (id: string) => present(h.state.commands.get(id), `the "${id}" command`);
const currentBox = () => present(h.state.boxes.at(-1), 'the most recently created input box');

// A real recompute chain (Instance re-read, provider rebuild, `hasRows()`) settles over a few
// ticks; the loop fails on its own assertion below, never the runner's timeout.
async function waitForMessage(
  view: { message?: string }, predicate: (m: string | undefined) => boolean, label: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate(view.message)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}; last message: ${String(view.message)}`);
}

async function makeInstance(root: string): Promise<Instance> {
  const instance = new Instance({
    instanceRoot: root,
    resolveGameDirectory: () => Promise.resolve(undefined),
    log: () => { /* no-op */ },
    logReadFailure: () => { /* no-op */ },
  });
  await instance.refresh();
  return instance;
}

describe('the Mods filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    h.state.boxes.length = 0;
    h.state.commands.clear();
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    await provider.getChildren(); // populate the cache off the first value

    const { modListView } = createModListView(own, provider, instance);
    await command('modbench.mod.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(modListView.message).toBe('No matches for "zzznomatch".');

    // A row change with no keystroke: a mod landing on disk that the term now matches.
    const modlistPath = join(root, DEFAULT_MODLIST);
    const original = await readFile(modlistPath, 'utf8');
    await writeFile(modlistPath, `${original}+zzznomatchMod\r\n`);
    await instance.refresh();
    await waitForMessage(modListView, (m) => m === undefined, 'the message clearing once a matching mod lands');
    expect(modListView.message).toBeUndefined();

    // And back — the same row change reversing, still with nobody typing.
    await writeFile(modlistPath, original);
    await instance.refresh();
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the mod is gone');
    expect(modListView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    h.state.boxes.length = 0;
    h.state.commands.clear();
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ },
    });
    const downloadsView = present(h.state.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

    await command('modbench.downloadedFile.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    // A row change with no keystroke: a download landing on disk that the term now matches.
    const archivePath = join(root, 'downloads', 'zzznomatch.7z');
    await writeFile(archivePath, '');
    await instance.refresh();
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once a matching download lands');
    expect(downloadsView.message).toBeUndefined();

    // And back — the same row change reversing, still with nobody typing.
    await rm(archivePath);
    await instance.refresh();
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the download is gone');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});
