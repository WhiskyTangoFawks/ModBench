import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  MarkdownString, uriFile, DataTransferItem, DataTransfer,
} from './vscodeMock';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';

const { showErrorMessage, showWarningMessage, showInformationMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  MarkdownString, DataTransferItem, DataTransfer,
  Uri: { file: uriFile },
  window: { showErrorMessage, showWarningMessage, showInformationMessage },
}));

import { Instance } from '../instanceLoader/instance';
import { ModListProvider } from '../mods/ModListProvider';
import { ErrorNode as ModsErrorNode } from '../mods/errorNode';
import { PluginsTreeProvider } from '../plugins/PluginsTreeProvider';
import { ErrorNode as PluginsErrorNode } from '../plugins/errorNode';
import { DownloadsProvider } from '../downloads/DownloadsProvider';
import { ErrorNode as DownloadsErrorNode } from '../downloads/errorNode';
import { makeReporter } from '../reporter';
import { FakeLogOutputChannel } from './fakeOutputChannel';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { expectInstanceOf } from './expectInstanceOf';

const roots: string[] = [];
const disposables: { dispose(): void }[] = [];

afterEach(async () => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
  vi.clearAllMocks();
});

function channelWrites(channel: FakeLogOutputChannel): unknown[][] {
  return [channel.trace, channel.debug, channel.info, channel.warn, channel.error, channel.append, channel.appendLine]
    .flatMap((spy) => spy.mock.calls);
}

// The three views over the one Instance, wired to the Output as the composition root wires them.
async function threeViewsOverOneInstance() {
  const root = await cloneCorpusFixture();
  roots.push(root);
  const channel = new FakeLogOutputChannel();
  const log = (msg: string) => { channel.info(msg); };
  const instance = new Instance({ instanceRoot: root, log, resolveGameDirectory: () => Promise.resolve(undefined) });
  const mods = new ModListProvider({ instance, log, instanceRoot: root, reporter: makeReporter(channel, 'modList') });
  const plugins = new PluginsTreeProvider({
    instance,
    source: { setPluginEnabled: () => Promise.resolve(), reorderPlugins: () => Promise.resolve() },
    log: (level, msg) => { channel[level](msg); },
    reporter: makeReporter(channel, 'pluginList'),
  });
  const downloads = new DownloadsProvider({ instance });
  disposables.push(instance, mods, plugins, downloads);
  const render = () => Promise.all([mods.getChildren(), plugins.getChildren(), downloads.getChildren()]);
  return { root, channel, instance, render };
}

describe('a failed first read across the Mods, Plugins and Downloads views', () => {
  it('shows each view the one error row, writes one Output line, raises no notification, and the next good read brings rows', async () => {
    const { root, channel, instance, render } = await threeViewsOverOneInstance();
    const ini = join(root, 'ModOrganizer.ini');
    const complete = await readFile(ini, 'utf8');
    await writeFile(ini, '');

    const pending = render();
    await instance.refresh();
    const rendered = await pending;

    const [modsRows, pluginsRows, downloadsRows] = rendered;
    const errors = [
      expectInstanceOf(modsRows[0], ModsErrorNode),
      expectInstanceOf(pluginsRows[0], PluginsErrorNode),
      expectInstanceOf(downloadsRows[0], DownloadsErrorNode),
    ];
    expect(rendered.map((rows) => rows.length)).toEqual([1, 1, 1]);
    const reason = instance.readFailure;
    expect(reason).toContain('ModOrganizer.ini');
    for (const error of errors) {
      expect(error.label).toBe(`Failed to load: ${reason}`);
      expect(error.tooltip).toBe(reason);
      expect(error.iconPath).toEqual(new ThemeIcon('error'));
    }
    const lines = channelWrites(channel);
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.[0])).toContain(String(reason));
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();

    await writeFile(ini, complete);
    await instance.refresh();
    for (const rows of await render()) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row instanceof ModsErrorNode || row instanceof PluginsErrorNode || row instanceof DownloadsErrorNode)).toBe(false);
    }
  });
});
