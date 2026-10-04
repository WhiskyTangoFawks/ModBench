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
import { CONFLICT_TABLE_READY, CONFLICT_TABLE_SHOWN, parseConflictTableShown } from '../../wire/conflictTable';
import type { FileCopies, FileOrigin } from '../../instanceLoader/instance';
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

  const shown = (panel: FakePanel) => panel.webview.posted.flatMap((message) => parseConflictTableShown(message) ?? []);
  const shownTables = (panel: FakePanel) => shown(panel).map(({ table }) => table);
  const posted = (panel: FakePanel, count: number) => vi.waitFor(() => expect(panel.webview.posted).toHaveLength(count));
  const ready = { type: CONFLICT_TABLE_READY };
  const unreadableHigh = (reason: string, origin: FileOrigin = { kind: 'mod', name: 'High' }) => (paths: readonly string[]) =>
    Promise.resolve(paths.map((relativePath) => ({
      relativePath,
      copies: [
        { origin, kind: 'unreadable' as const, reason },
        { origin: { kind: 'mod' as const, name: 'Low' }, kind: 'read' as const, sameAs: 0 },
      ],
    })));

  it('is titled with the mod\'s name, and loads the conflict table\'s page and its icons', async () => {
    const panel = openTable(new FakeInstance(await shared()), 'High');

    expect(panel.title).toBe('Conflicts: High');
    expect(panel.webview.html).toContain('assets/conflicts.js');
    expect(panel.webview.html).toContain('assets/main.css');
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
    panel.webview.receive?.(ready);
    await posted(panel, 1);

    expect(instance.askedForCopies).toEqual([['a.dds']]);
    expect(shownTables(panel)).toEqual([{
      kind: 'table',
      columns: [
        { name: 'Low', origin: { kind: 'mod', name: 'Low' }, opened: false, state: 'Master' },
        { name: 'High', origin: { kind: 'mod', name: 'High' }, opened: true, state: 'Override' },
      ],
      rows: [{ kind: 'file', name: 'a.dds', path: 'a.dds', state: 'Override', cells: [{ state: 'Master' }, { state: 'Override', winning: true }] }],
    }]);
  });

  it('shows an empty table while the instance is not read yet, asking for no copies', async () => {
    const instance = new FakeInstance(instanceValueFixture(), 0);
    const panel = openTable(instance, 'High');

    panel.webview.receive?.(ready);
    await posted(panel, 1);

    expect(shownTables(panel)).toEqual([{ kind: 'table', columns: [], rows: [] }]);
    expect(instance.askedForCopies.flat()).toEqual([]);
  });

  it('follows the disk: each new instance value shows, until the tab closes', async () => {
    const instance = new FakeInstance(await shared());
    const panel = openTable(instance, 'High');

    instance.publish(await indexedValueOf([mod('High')], { High: { files: [file('High', 'a.dds')] } }));
    await posted(panel, 1);
    panel.dispose?.();
    instance.publish(await indexedValueOf([mod('Low')], {}));

    expect(shownTables(panel)).toEqual([{ kind: 'message', text: 'No file order conflicts.' }]);
    expect(instance.askedForCopies).toHaveLength(1);
  });

  it('shows the answer of the newest value only, though an older one answers last', async () => {
    const instance = new FakeInstance(await shared());
    const answers: (() => void)[] = [];
    const asked: Promise<unknown>[] = [];
    instance.copies = (paths) => {
      const answer = new Promise<FileCopies[]>((resolve) => {
        answers.push(() => resolve(paths.map((relativePath) => ({ relativePath, copies: [] }))));
      });
      asked.push(answer);
      return answer;
    };
    const panel = openTable(instance, 'High');
    panel.webview.receive?.(ready);
    instance.publish(await indexedValueOf([mod('High'), mod('Low')], {
      High: { files: [file('High', 'a.dds'), file('High', 'b.dds')] }, Low: { files: [file('Low', 'a.dds'), file('Low', 'b.dds')] },
    }));

    answers[1]?.();
    await posted(panel, 1);
    answers[0]?.();
    await asked[0];

    expect(shownTables(panel).map((table) => (table.kind === 'table' ? table.rows.length : -1))).toEqual([2]);
  });

  describe('a copy that cannot be read', () => {
    it('is one line in the Output, naming the copy and why, however often the disk changes', async () => {
      const instance = new FakeInstance(await shared());
      instance.copies = unreadableHigh('in use');
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);
      panel.webview.receive?.(ready);
      await posted(panel, 1);

      instance.publish(await shared());
      await posted(panel, 2);

      expect(reporter.shownFailures).toEqual([
        { severity: 'warning', message: 'Conflicts: "High"\'s copy of a.dds could not be read.', detail: 'in use' },
      ]);
      expect(reporter.reports).toEqual([]);
    });

    it('is said again when it recovers and fails again, and when its reason changes', async () => {
      const instance = new FakeInstance(await shared());
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);
      const publishAs = async (copies: typeof instance.copies, count: number) => {
        instance.copies = copies;
        instance.publish(await shared());
        await posted(panel, count);
      };

      await publishAs(unreadableHigh('in use'), 1);
      await publishAs(() => Promise.resolve([]), 2);
      await publishAs(unreadableHigh('in use'), 3);
      await publishAs(unreadableHigh('access denied'), 4);

      expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['in use', 'in use', 'access denied']);
    });

    it('is told apart by its origin: a mod named as Overwrite is not Overwrite', async () => {
      const instance = new FakeInstance(await shared());
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);
      const unreadable = (...origins: FileOrigin[]) => (paths: readonly string[]) => Promise.resolve(paths.map((relativePath) => ({
        relativePath, copies: origins.map((origin) => ({ origin, kind: 'unreadable' as const, reason: 'in use' })),
      })));
      instance.copies = unreadable({ kind: 'mod', name: 'Overwrite' });
      panel.webview.receive?.(ready);
      await posted(panel, 1);
      instance.copies = unreadable({ kind: 'mod', name: 'Overwrite' }, { kind: 'runtimeOutput' });

      instance.publish(await shared());
      await posted(panel, 2);

      expect(reporter.shownFailures).toHaveLength(2);
    });
  });

  describe('a which-copies request that failed', () => {
    it('is, before any table, the error row in place of it and a line in the Output, with no notification', async () => {
      const instance = new FakeInstance(await shared());
      instance.copies = () => Promise.reject(new Error('disk gone'));
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);

      panel.webview.receive?.(ready);
      await posted(panel, 1);

      expect(shown(panel)).toEqual([{ type: CONFLICT_TABLE_SHOWN, table: { kind: 'error', reason: 'disk gone' } }]);
      expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'Failed to read the copies of "High"\'s conflicts.', detail: 'disk gone' }]);
      expect(reporter.reports).toEqual([]);
    });

    it('is, after a table, the rows staying under the message line, which the next good read clears', async () => {
      const instance = new FakeInstance(await shared());
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);
      panel.webview.receive?.(ready);
      await posted(panel, 1);
      instance.copies = () => Promise.reject(new Error('disk gone'));

      instance.publish(await shared());
      await posted(panel, 2);
      instance.copies = () => Promise.resolve([]);
      instance.publish(await shared());
      await posted(panel, 3);

      const [first, failed, recovered] = shown(panel);
      expect(failed).toEqual({ ...first, notice: 'Showing the last good read: disk gone' });
      expect(recovered).toEqual(first);
      expect(reporter.shownFailures).toHaveLength(1);
      expect(reporter.reports).toEqual([]);
    });

    it('is not reported once a newer value has asked', async () => {
      const instance = new FakeInstance(await shared());
      const rejections: ((reason: Error) => void)[] = [];
      const asked: Promise<unknown>[] = [];
      instance.copies = (paths) => {
        if (asked.length === 0) {
          const late = new Promise<FileCopies[]>((_, reject) => { rejections.push(reject); });
          asked.push(late);
          return late;
        }
        asked.push(Promise.resolve([]));
        return Promise.resolve(paths.map((relativePath) => ({ relativePath, copies: [] })));
      };
      const reporter = recordingReporter();
      const panel = openTable(instance, 'High', reporter);
      panel.webview.receive?.(ready);
      instance.publish(await shared());
      await posted(panel, 1);

      rejections[0]?.(new Error('old'));
      await asked[0]?.catch(() => undefined);

      expect(reporter.shownFailures).toEqual([]);
      expect(panel.webview.posted).toHaveLength(1);
    });
  });
});
