import { describe, it, expect, vi } from 'vitest';

const registerCustomEditorProvider = vi.fn<(...args: unknown[]) => { dispose(): void }>(() => ({ dispose: () => undefined }));

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose: () => undefined }); fire() { /* no listeners */ } dispose() { /* nothing held */ } },
  Uri: { from: vi.fn(), joinPath: vi.fn() },
  ViewColumn: { One: 1, Beside: -2 },
  commands: { registerCommand: () => ({ dispose: () => undefined }), executeCommand: vi.fn() },
  window: {
    registerFileDecorationProvider: () => ({ dispose: () => undefined }),
    registerCustomEditorProvider: (...args: unknown[]) => registerCustomEditorProvider(...args),
  },
}));

import { registerEditorCommands, type EditorCommandDeps } from '../recordPanelHost';
import { InMemoryMEditClient } from '../../client';

describe('registerEditorCommands', () => {
  it('keeps a record tab\'s page alive while it is hidden, so it is as I left it on return', () => {
    const deps = {
      meditClient: new InMemoryMEditClient(), outputChannel: {}, mergedTreeSelection: () => [],
      reporterFor: () => ({}), ask: vi.fn(), recordBadgeSource: { onDidReadRecords: () => ({ dispose: () => undefined }) },
    } as unknown as EditorCommandDeps;

    registerEditorCommands(deps);

    expect(registerCustomEditorProvider).toHaveBeenCalledWith(
      'modbench.record', expect.anything(), { webviewOptions: { retainContextWhenHidden: true } },
    );
  });
});
