import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const executeCommand = vi.fn<(...args: unknown[]) => unknown>();
const pickRecord = vi.fn<(...args: unknown[]) => Promise<string | null>>();

vi.mock('../recordPicker', () => ({ pickRecord: (...args: unknown[]) => pickRecord(...args) }));

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose: () => undefined }); fire() { /* no listeners */ } dispose() { /* nothing held */ } },
  Uri: { from: (parts: { path: string }) => parts.path, joinPath: vi.fn() },
  ViewColumn: { Active: -1, One: 1, Beside: -2 },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: (...args: unknown[]) => executeCommand(...args),
  },
  window: {
    registerFileDecorationProvider: () => ({ dispose: () => undefined }),
    registerCustomEditorProvider: (...args: unknown[]) => registerCustomEditorProvider(...args),
  },
}));

import * as vscode from 'vscode';
import { registerEditorCommands } from '../recordPanelHost';
import { ActiveRecordTracker } from '../ActiveRecordTracker';
import { EditsInFlight } from '../followRecord';
import { FocusedCells } from '../focusedCells';
import { InMemoryMEditClient, type NotificationEvent } from '../../client';
import { noRecordWriteMarks } from '../../test/recordWriteMarks';

const reporter = { report: vi.fn(), landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() };

function register(
  focusedViewSelection: () => readonly unknown[] = () => [],
  panels: { recordPanels: Set<vscode.WebviewPanel>; tracker: ActiveRecordTracker<vscode.WebviewPanel>; meditClient: InMemoryMEditClient }
    = { recordPanels: new Set(), tracker: new ActiveRecordTracker<vscode.WebviewPanel>(), meditClient: new InMemoryMEditClient() },
  override: {
    meditClient?: InMemoryMEditClient; refreshPanels?: () => void; focusedCells?: FocusedCells<vscode.WebviewPanel>;
  } = {},
): void {
  const { recordPanels, tracker } = panels;
  const meditClient = override.meditClient ?? panels.meditClient;
  registerEditorCommands({
    context: { extensionUri: vscode.Uri.from({ scheme: 'file' }) },
    recordPanels,
    activeRecordTracker: tracker,
    editsInFlight: new EditsInFlight(tracker),
    focusedCells: override.focusedCells ?? new FocusedCells(() => undefined, () => undefined),
    recordBadgeSource: { workingTreeStateOf: () => undefined, onDidReadRecords: () => ({ dispose: () => undefined }) },
    meditClient,
    refreshPanels: override.refreshPanels ?? (() => undefined),
    focusedViewSelection,
    viewSelections: new Map(),
    recordMarks: noRecordWriteMarks,
    refreshSourceControlFor: () => undefined,
    outputChannel: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    reporterFor: () => reporter,
    ask: vi.fn(),
    fieldFile: () => ({ folder: '', file: '' }),
  });
}

beforeEach(() => {
  commandHandlers.clear();
  executeCommand.mockReset();
  pickRecord.mockReset();
});

describe('registerEditorCommands', () => {
  it('keeps a record tab\'s page alive while it is hidden, so it is as I left it on return', () => {
    register();

    expect(registerCustomEditorProvider).toHaveBeenCalledWith(
      'modbench.record', expect.anything(), { webviewOptions: { retainContextWhenHidden: true } },
    );
  });
});

describe('modbench.record.open from the palette, with no Argument', () => {
  const open = () => commandHandlers.get('modbench.record.open')?.();

  it('opens the records selected in the focused view, each in a tab of its own', async () => {
    register(() => [{ formKey: '000801:A.esp', kind: 'placed' }, { kind: 'record', record: { formKey: '000802:A.esp' } }]);

    await open();

    const opened = executeCommand.mock.calls.filter(([id]) => id === 'vscode.openWith');
    expect(opened.map(([, , , options]) => options)).toEqual([
      { viewColumn: -1, preview: false }, { viewColumn: -1, preview: false },
    ]);
  });

  it('asks for a record when the focused view has none selected, and opens the one picked as a preview', async () => {
    pickRecord.mockResolvedValue('000801:A.esp');
    register(() => [{ kind: 'recordType' }]);

    await open();

    expect(pickRecord.mock.calls).toEqual([[{ meditClient: expect.any(InMemoryMEditClient) as unknown, reporter }, '', []]]);
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith', `/${encodeURIComponent('000801:A.esp')}.modbench-record`, 'modbench.record',
      { viewColumn: -1, preview: true });
  });

  it('opens nothing when the picker is dismissed', async () => {
    pickRecord.mockResolvedValue(null);
    register();

    await open();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses, saying why, when it is given something that names no record', async () => {
    reporter.report.mockClear();
    register();

    await commandHandlers.get('modbench.record.open')?.({ kind: 'recordType' });

    expect(reporter.report).toHaveBeenCalledWith('error', 'Could not open a record.', 'What was given names no record.');
    expect(pickRecord).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('does not ask when the selection holds a record', async () => {
    register(() => [{ formKey: '000801:A.esp', kind: 'placed' }]);

    await open();

    expect(pickRecord).not.toHaveBeenCalled();
  });
});

describe('modbench.record.editField, fired with only the record, the plugin and the field path', () => {
  const MOVED = '000900:Mod.esp';
  const isPanel = (value: object): value is vscode.WebviewPanel => 'webview' in value;
  const posting = () => vi.fn(() => Promise.resolve(true));
  const fakePanel = (postMessage = posting()): vscode.WebviewPanel => {
    const panel = { title: '000800:Mod.esp', webview: { postMessage } };
    if (!isPanel(panel)) throw new Error('not a panel');
    return panel;
  };

  it('moves every tab showing the record to its new FormKey, as an agent fires it with no panel', async () => {
    const tracker = new ActiveRecordTracker<vscode.WebviewPanel>();
    const meditClient = new InMemoryMEditClient();
    meditClient.setCommandResult('editRecord', { applied: true, newFormKey: MOVED });
    const shown = [fakePanel(), fakePanel()];
    const elsewhere = fakePanel();
    for (const panel of shown) tracker.setFormKey(panel, '000800:Mod.esp');
    tracker.setFormKey(elsewhere, '000801:Mod.esp');
    register(() => [], { recordPanels: new Set([...shown, elsewhere]), tracker, meditClient });

    await commandHandlers.get('modbench.record.editField')?.(
      { formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA' }, { op: 'set', path: [{ kind: 'member', name: 'FormID' }], value: 'x' });

    expect(shown.map(panel => tracker.formKeyOf(panel))).toEqual([MOVED, MOVED]);
    expect(tracker.formKeyOf(elsewhere)).toBe('000801:Mod.esp');
    expect(meditClient.calls.filter(c => c.method === 'editRecord')).toHaveLength(1);
  });

  it('tells every open panel the edit as it is sent', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setCommandResult('editRecord', { applied: true });
    const first = posting();
    const second = posting();
    register(() => [], {
      recordPanels: new Set([fakePanel(first), fakePanel(second)]), tracker: new ActiveRecordTracker<vscode.WebviewPanel>(), meditClient,
    });
    const envelope = { op: 'set', path: [{ kind: 'member', name: 'Name' }], value: 'x' };
    const written = { type: 'editWritten', formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA', envelope };

    await commandHandlers.get('modbench.record.editField')?.({ formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA' }, envelope);

    expect(first).toHaveBeenCalledWith(written);
    expect(second).toHaveBeenCalledWith(written);
  });
});

describe('the record grid\'s F2', () => {
  it('opens the editor of the focused cell of the record tab in focus, and of no other tab', async () => {
    const [behind, inFocus] = [vi.fn(() => Promise.resolve(true)), vi.fn(() => Promise.resolve(true))];
    const isPanel = (value: object): value is vscode.WebviewPanel => 'webview' in value;
    const panel = (postMessage: () => Promise<boolean>): vscode.WebviewPanel => {
      const fake = { webview: { postMessage } };
      if (!isPanel(fake)) throw new Error('not a panel');
      return fake;
    };
    const focusedCells = new FocusedCells<vscode.WebviewPanel>(() => undefined, () => undefined);
    focusedCells.setActivePanel(panel(behind));
    focusedCells.setActivePanel(panel(inFocus));
    register(() => [], undefined, { focusedCells });

    await commandHandlers.get('modbench.recordGrid.editHere')?.();

    expect(inFocus).toHaveBeenCalledWith({ type: 'openCellEditor' });
    expect(behind).not.toHaveBeenCalled();
  });
});

describe('modbench.record.openToSide, the menus\' entry point', () => {
  it('fires open with the menu selection, each record placed beside', async () => {
    register();
    const [a, b] = [{ formKey: '000801:A.esp' }, { formKey: '000802:A.esp' }];

    await commandHandlers.get('modbench.record.openToSide')?.(a, [a, b]);

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.open', [
      { ...a, placement: 'beside' }, { ...b, placement: 'beside' },
    ]);
  });
});

describe('a record panel open while mEdit reports a plugin it cannot read', () => {
  const tick = (failures: { name: string; origin: string; reason: string }[]): NotificationEvent => ({
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 1, activePlugins: 1, indexedPlugins: [], conflictsComputed: false, failures, version: 1,
    },
  });
  const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

  it('has the panels refreshed on a failure arriving and on it clearing, and not on an identical tick', () => {
    const meditClient = new InMemoryMEditClient();
    const refreshPanels = vi.fn();
    register(() => [], undefined, { meditClient, refreshPanels });

    meditClient.emit(tick([bad]));
    meditClient.emit(tick([bad]));
    expect(refreshPanels).toHaveBeenCalledTimes(1);
    meditClient.emit(tick([]));
    expect(refreshPanels).toHaveBeenCalledTimes(2);
  });
});
