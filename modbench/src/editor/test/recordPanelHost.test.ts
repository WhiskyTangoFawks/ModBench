import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const executeCommand = vi.fn<(...args: unknown[]) => unknown>();
const setStatusBarMessage = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose: () => undefined }); fire() { /* no listeners */ } dispose() { /* nothing held */ } },
  Uri: { from: (parts: { path: string }) => parts.path, joinPath: vi.fn() },
  ViewColumn: { One: 1, Beside: -2 },
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
    setStatusBarMessage: (...args: unknown[]) => setStatusBarMessage(...args),
  },
}));

import * as vscode from 'vscode';
import { registerEditorCommands } from '../recordPanelHost';
import { ActiveRecordTracker } from '../ActiveRecordTracker';
import { EditsInFlight } from '../followRecord';
import { FocusedCells } from '../focusedCells';
import { InMemoryMEditClient } from '../../client';

const reporter = { report: vi.fn(), landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() };

function register(
  focusedViewSelection: () => readonly unknown[] = () => [],
  panels: { recordPanels: Set<vscode.WebviewPanel>; tracker: ActiveRecordTracker<vscode.WebviewPanel>; meditClient: InMemoryMEditClient }
    = { recordPanels: new Set(), tracker: new ActiveRecordTracker<vscode.WebviewPanel>(), meditClient: new InMemoryMEditClient() },
): void {
  const { recordPanels, tracker, meditClient } = panels;
  registerEditorCommands({
    context: { extensionUri: vscode.Uri.from({ scheme: 'file' }) },
    recordPanels,
    activeRecordTracker: tracker,
    editsInFlight: new EditsInFlight(tracker),
    focusedCells: new FocusedCells(() => undefined, () => undefined),
    recordBadgeSource: { workingTreeStateOf: () => undefined, onDidReadRecords: () => ({ dispose: () => undefined }) },
    meditClient,
    mergedTreeSelection: () => [],
    focusedViewSelection,
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
  setStatusBarMessage.mockReset();
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
      { viewColumn: 1, preview: false }, { viewColumn: 1, preview: false },
    ]);
  });

  it('says what to select when the focused view has no record selected, and opens nothing', async () => {
    register(() => [{ kind: 'recordType' }]);

    await open();

    expect(setStatusBarMessage).toHaveBeenCalledWith('Select a record in Plugins or Referenced By to open it.', 5000);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('modbench.record.editField, fired with only the record, the plugin and the field path', () => {
  const MOVED = '000900:Mod.esp';
  const isPanel = (value: object): value is vscode.WebviewPanel => 'webview' in value;
  const fakePanel = (): vscode.WebviewPanel => {
    const panel = { title: '000800:Mod.esp', webview: { postMessage: vi.fn(() => Promise.resolve(true)) } };
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
