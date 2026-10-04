import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, uriFile, uriFrom } from '../../test/vscodeMock';

const { registerCommand, executeCommand, registerCustomEditorProvider } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve()),
  registerCustomEditorProvider: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { registerCustomEditorProvider },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom, joinPath: (base: unknown, ...parts: string[]) => [String(base), ...parts].join('/') },
}));

import * as vscode from 'vscode';
import { CONFLICT_TABLE_VIEW_TYPE, conflictTableUri, registerConflictTable } from '../conflictTableEditor';
import { ModNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { file, indexedValueOf, mod } from './indexedValue';
import { CONFLICT_TABLE_READY, parseConflictTableShown } from '../../wire/conflictTable';
import { recordingReporter } from '../../test/surfacingDoubles';

const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });

function setup(instance = new FakeInstance(instanceValueFixture()), selection: readonly ModlistNode[] = [], reporter = recordingReporter()) {
  registerConflictTable(instance, vscode.Uri.file('/extension'), () => selection, reporter);
  const openConflicts = (...args: unknown[]) =>
    registerCommand.mock.calls.find(([id]) => id === 'modbench.mod.openConflicts')?.[1](...args);
  const opened = () => executeCommand.mock.calls.filter(([id]) => id === 'vscode.openWith');
  return { openConflicts, opened, reporter };
}

describe('open conflicts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the right-clicked mod\'s table as a preview editor', async () => {
    const { openConflicts, opened } = setup();

    await openConflicts(modRow('Textures'));

    expect(opened()).toEqual([['vscode.openWith', conflictTableUri('Textures'), CONFLICT_TABLE_VIEW_TYPE, { preview: true }]]);
  });

  it('opens a column header\'s mod\'s table', async () => {
    const { openConflicts, opened } = setup();

    await openConflicts({ webviewSection: 'conflictColumn', mod: 'Meshes', preventDefaultContextMenuItems: true });

    expect(opened().map(([, uri]) => uri)).toEqual([conflictTableUri('Meshes')]);
  });

  it('from the palette, opens the table of the one mod selected in Mods', async () => {
    const { openConflicts, opened } = setup(undefined, [modRow('Textures')]);

    await openConflicts();

    expect(opened().map(([, uri]) => uri)).toEqual([conflictTableUri('Textures')]);
  });

  it('opens nothing on a row that is not a mod, or with no mod selected', async () => {
    const { openConflicts, opened } = setup(undefined, [modRow('A'), modRow('B')]);

    await openConflicts(new SeparatorNode({ kind: 'separator', name: 'Group', enabled: true }, []));
    await openConflicts();
    await openConflicts({ webviewSection: 'recordHeader', plugin: 'A.esp', origin: 'A' });

    expect(opened()).toEqual([]);
  });

  it('addresses a mod\'s table by the mod alone: the same mod the same way every time, two mods apart', () => {
    expect(conflictTableUri('Textures')).toEqual(conflictTableUri('Textures'));
    expect(conflictTableUri('Textures')).not.toEqual(conflictTableUri('Meshes'));
  });

  it('reports a table VS Code could not open, naming the mod', async () => {
    const { openConflicts, reporter } = setup();
    executeCommand.mockRejectedValueOnce(new Error('no editor'));

    await openConflicts(modRow('Textures'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to open the conflicts of "Textures".', detail: 'no editor' }]);
  });
});

interface FakePanel {
  title: string;
  webview: {
    html: string; options: unknown; cspSource: string; asWebviewUri: (uri: unknown) => unknown;
    posted: unknown[]; postMessage: (message: unknown) => Promise<boolean>;
    receive: ((message: unknown) => void) | undefined; onDidReceiveMessage: (listener: (message: unknown) => void) => void;
  };
  dispose: (() => void) | undefined;
  onDidDispose: (listener: () => void) => void;
}

function fakePanel(): FakePanel {
  const panel: FakePanel = {
    title: '',
    webview: {
      html: '', options: undefined, cspSource: 'csp', asWebviewUri: (uri) => uri, posted: [],
      postMessage: (message) => { panel.webview.posted.push(message); return Promise.resolve(true); },
      receive: undefined, onDidReceiveMessage: (listener) => { panel.webview.receive = listener; },
    },
    dispose: undefined,
    onDidDispose: (listener) => { panel.dispose = listener; },
  };
  return panel;
}

interface ResolvingProvider {
  openCustomDocument: (uri: vscode.Uri) => vscode.CustomDocument;
  resolveCustomEditor: (document: vscode.CustomDocument, panel: FakePanel) => void;
}

function isResolvingProvider(value: unknown): value is ResolvingProvider {
  return typeof value === 'object' && value !== null && 'openCustomDocument' in value && 'resolveCustomEditor' in value;
}

function openTable(instance: FakeInstance, modName: string, reporter = recordingReporter()): FakePanel {
  setup(instance, [], reporter);
  const [viewType, provider, options] = registerCustomEditorProvider.mock.calls.at(-1) ?? [];
  expect(viewType).toBe(CONFLICT_TABLE_VIEW_TYPE);
  expect(options).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
  if (!isResolvingProvider(provider)) throw new Error('no custom editor provider was registered');
  const panel = fakePanel();
  provider.resolveCustomEditor(provider.openCustomDocument(conflictTableUri(modName)), panel);
  return panel;
}

describe('a mod\'s conflict table, open in a tab', () => {
  beforeEach(() => vi.clearAllMocks());

  const shared = () => indexedValueOf([mod('High'), mod('Low')], {
    High: { files: [file('High', 'a.dds')] }, Low: { files: [file('Low', 'a.dds')] },

  });

  const shownTables = (panel: FakePanel) => panel.webview.posted.flatMap((message) => parseConflictTableShown(message)?.table ?? []);
  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('is titled with the mod\'s name, and loads the conflict table\'s page', async () => {
    const panel = openTable(new FakeInstance(await shared()), 'High');

    expect(panel.title).toBe('Conflicts: High');
    expect(panel.webview.html).toContain('assets/conflicts.js');
    expect(panel.webview.html).not.toContain('<link');
  });

  it('shows the table, each cell and header in the state the which-copies answer gives, once the page is ready to hear it', async () => {
    const instance = new FakeInstance(await shared());
    instance.copies = (paths) => Promise.resolve(paths.map((relativePath) => ({
      relativePath,
      copies: [
        { origin: { kind: 'mod', name: 'High' }, kind: 'read', sameAs: 1 },
        { origin: { kind: 'mod', name: 'Low' }, kind: 'read', sameAs: 0 },
      ],
    })));
    const panel = openTable(instance, 'High');
    panel.webview.receive?.({ type: 'log' });
    await flush();
    expect(panel.webview.posted).toEqual([]);

    panel.webview.receive?.({ type: CONFLICT_TABLE_READY });
    await flush();

    expect(instance.askedForCopies).toEqual([['a.dds']]);
    expect(shownTables(panel)).toEqual([{
      kind: 'table',
      columns: [
        { name: 'Low', origin: { kind: 'mod', name: 'Low' }, opened: false, state: 'Master' },
        { name: 'High', origin: { kind: 'mod', name: 'High' }, opened: true, state: 'Override' },
      ],
      rows: [{ kind: 'file', name: 'a.dds', path: 'a.dds', state: 'Override', cells: [{ state: 'Master' }, { state: 'Override' }] }],
    }]);
  });

  it('shows an empty table while the instance is not read yet, asking for no copies', async () => {
    const instance = new FakeInstance(instanceValueFixture(), 0);
    const panel = openTable(instance, 'High');

    panel.webview.receive?.({ type: CONFLICT_TABLE_READY });
    await flush();

    expect(shownTables(panel)).toEqual([{ kind: 'table', columns: [], rows: [] }]);
    expect(instance.askedForCopies.flat()).toEqual([]);
  });

  it('follows the disk: each new instance value shows, until the tab closes', async () => {
    const instance = new FakeInstance(await shared());
    const panel = openTable(instance, 'High');

    instance.publish(await indexedValueOf([mod('High')], { High: { files: [file('High', 'a.dds')] } }));
    await flush();
    panel.dispose?.();
    instance.publish(await indexedValueOf([mod('Low')], {}));
    await flush();

    expect(shownTables(panel)).toEqual([{ kind: 'message', text: 'No file order conflicts.' }]);
  });

  it('shows the answer of the newest value only, though an older one answers last', async () => {
    const instance = new FakeInstance(await shared());
    const answers: (() => void)[] = [];
    instance.copies = (paths) => new Promise((resolve) => {
      answers.push(() => resolve(paths.map((relativePath) => ({ relativePath, copies: [] }))));
    });
    const panel = openTable(instance, 'High');
    panel.webview.receive?.({ type: CONFLICT_TABLE_READY });
    instance.publish(await indexedValueOf([mod('High'), mod('Low')], {
      High: { files: [file('High', 'a.dds'), file('High', 'b.dds')] }, Low: { files: [file('Low', 'a.dds'), file('Low', 'b.dds')] },
    }));

    answers[1]?.();
    await flush();
    answers[0]?.();
    await flush();

    expect(shownTables(panel).map((table) => (table.kind === 'table' ? table.rows.length : -1))).toEqual([2]);
  });

  describe('a copy that cannot be read', () => {
    const unreadable = (instance: FakeInstance) => {
      instance.copies = (paths) => Promise.resolve(paths.map((relativePath) => ({
        relativePath,
        copies: [
          { origin: { kind: 'mod', name: 'High' }, kind: 'unreadable', reason: 'in use' },
          { origin: { kind: 'mod', name: 'Low' }, kind: 'read', sameAs: 0 },
        ],
      })));
    };

    it('is one line in the Output, naming the copy and why, however often the disk changes', async () => {
      const instance = new FakeInstance(await shared());
      unreadable(instance);
      const reporter = recordingReporter();
      openTable(instance, 'High', reporter).webview.receive?.({ type: CONFLICT_TABLE_READY });
      await flush();

      instance.publish(await shared());
      await flush();

      expect(reporter.dialogFailures).toEqual([
        { severity: 'warning', message: 'Conflicts: "High"\'s copy of a.dds could not be read.', detail: 'in use' },
      ]);
      expect(reporter.reports).toEqual([]);
    });

    it('is said again when it recovers and fails again', async () => {
      const instance = new FakeInstance(await shared());
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);
      unreadable(instance);
      panel.webview.receive?.({ type: CONFLICT_TABLE_READY });
      await flush();
      instance.copies = () => Promise.resolve([]);
      instance.publish(await shared());
      await flush();
      unreadable(instance);

      instance.publish(await shared());
      await flush();

      expect(reporter.dialogFailures).toHaveLength(2);
    });
  });

  it('reports a which-copies request that failed, and shows nothing for it', async () => {
    const instance = new FakeInstance(await shared());
    instance.copies = () => Promise.reject(new Error('disk gone'));
    const reporter = recordingReporter();
    const panel = openTable(instance, 'High', reporter);

    panel.webview.receive?.({ type: CONFLICT_TABLE_READY });
    await flush();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to read the copies of "High"\'s conflicts.', detail: 'disk gone' }]);
    expect(panel.webview.posted).toEqual([]);
  });
});
