import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  uriFile, DataTransferItem, DataTransfer,
} from './vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, commandInvoker, currentBoxOf, waitForMessage,
} from './nameFilterViewHarness';

// A mod or a download landing on disk is a row change with no keystroke; Show hidden changes
// rows with no new Instance value either. Real Instance and provider over the corpus fixture.

// `../mo2TreeViews` reaches `vscode` before this file's own top-level code runs, so the state
// `vi.mock` closes over is built from literals here. `trees` is this file's own tracking of the
// one view `registerDownloadsView` does not return.
const h = vi.hoisted(() => ({
  state: { commands: new Map<string, (...args: unknown[]) => unknown>(), boxes: [] },
  trees: new Map<string, { description?: string; message?: string }>(),
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
  window: {
    ...filterBoxWindowMock(h.state),
    createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
      const view = { ...options, description: undefined, message: undefined };
      h.trees.set(id, view);
      return view;
    },
    registerFileDecorationProvider: () => ({ dispose() { /* no-op */ } }),
  },
  commands: filterBoxCommandsMock(h.state),
}));

import { Instance } from '../instanceLoader/instance';
import { ModListProvider } from '../mods/ModListProvider';
import { createModListView, registerDownloadsView } from '../mo2TreeViews';
import { present } from '../ports/present';
import { recordingReporter } from './surfacingDoubles';

const own = <T extends { dispose: () => void }>(d: T): T => d;
const command = commandInvoker(h.state);
const currentBox = currentBoxOf(h.state);

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

beforeEach(() => {
  h.state.boxes.length = 0;
  h.state.commands.clear();
});

describe('the Mods filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    await provider.getChildren();

    const { modListView } = createModListView(own, provider, instance);
    await command('modbench.mod.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(modListView.message).toBe('No matches for "zzznomatch".');

    const modlistPath = join(root, DEFAULT_MODLIST);
    const original = await readFile(modlistPath, 'utf8');
    await writeFile(modlistPath, `${original}+zzznomatchMod\r\n`);
    await instance.refresh();
    await waitForMessage(modListView, (m) => m === undefined, 'the message clearing once a matching mod lands');
    expect(modListView.message).toBeUndefined();

    await writeFile(modlistPath, original);
    await instance.refresh();
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the mod is gone');
    expect(modListView.message).toBe('No matches for "zzznomatch".');
  });
});

// A profile switch writes and forgets, so nothing but the watch can move this readout.
describe('the Mods view\'s description follows the active profile', () => {
  it('reads the new profile off a new instance value, with nothing pushed', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    const { modListView } = createModListView(own, provider, instance);
    expect(modListView.description).toBe('Default');

    const ini = join(root, 'ModOrganizer.ini');
    const text = await readFile(ini, 'utf8');
    await writeFile(ini, text.replace('selected_profile=@ByteArray(Default)', 'selected_profile=@ByteArray(Secondary)'));
    await instance.refresh();

    expect(modListView.description).toBe('Secondary');
  });
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ },
    });
    const downloadsView = present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

    await command('modbench.downloadedFile.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    const archivePath = join(root, 'downloads', 'zzznomatch.7z');
    await writeFile(archivePath, '');
    await instance.refresh();
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once a matching download lands');
    expect(downloadsView.message).toBeUndefined();

    await rm(archivePath);
    await instance.refresh();
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the download is gone');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Downloads filter follows a toggle with no new instance value', () => {
  it('recomputes the no-match message off Show hidden, in both directions', async () => {
    const root = await cloneCorpusFixture();
    const archivePath = join(root, 'downloads', 'zzznomatch.7z');
    await writeFile(archivePath, '');
    await writeFile(`${archivePath}.meta`, '[General]\r\nremoved=true\r\n');
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ },
    });
    const downloadsView = present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

    await command('modbench.downloadedFile.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message with the hidden download excluded');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    await command('modbench.downloadedFile.showExcluded')();
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once the hidden download counts');
    expect(downloadsView.message).toBeUndefined();

    await command('modbench.downloadedFile.hideExcluded')();
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once hidden rows are excluded again');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});
