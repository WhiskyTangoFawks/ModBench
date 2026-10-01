import { describe, it, expect, vi } from 'vitest';

const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose: () => undefined }); fire() { /* no listeners */ } dispose() { /* nothing held */ } },
  Uri: { from: () => undefined, joinPath: vi.fn() },
  ViewColumn: { One: 1, Beside: -2 },
  commands: { registerCommand: () => ({ dispose: () => undefined }), executeCommand: vi.fn() },
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
import { InMemoryMEditClient } from '../../client';

const reporter = { report: vi.fn(), landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() };

describe('registerEditorCommands', () => {
  it('keeps a record tab\'s page alive while it is hidden, so it is as I left it on return', () => {
    const tracker = new ActiveRecordTracker<vscode.WebviewPanel>();

    registerEditorCommands({
      context: { extensionUri: vscode.Uri.from({ scheme: 'file' }) },
      recordPanels: new Set(),
      activeRecordTracker: tracker,
      editsInFlight: new EditsInFlight(tracker),
      focusedCells: new FocusedCells(() => undefined),
      recordBadgeSource: { workingTreeStateOf: () => undefined, onDidReadRecords: () => ({ dispose: () => undefined }) },
      meditClient: new InMemoryMEditClient(),
      mergedTreeSelection: () => [],
      refreshSourceControlFor: () => undefined,
      outputChannel: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      reporterFor: () => reporter,
      ask: vi.fn(),
      fieldFile: () => ({ folder: '', file: '' }),
    });

    expect(registerCustomEditorProvider).toHaveBeenCalledWith(
      'modbench.record', expect.anything(), { webviewOptions: { retainContextWhenHidden: true } },
    );
  });
});
