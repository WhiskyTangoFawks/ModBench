import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a row's handler can be invoked directly — the
// same idiom recordPanelContextCommands.test.ts and pluginRowCommands.test.ts already establish.
const {
  handlers, registerCommand, showWarningMessage, showErrorMessage, showInformationMessage, showInputBox, showQuickPick,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showWarningMessage, showErrorMessage, showInformationMessage, showInputBox, showQuickPick },
}));

import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, recordIdentity, recordTypeIdentity,
} from '../recordLifecycleCommands';
import { InMemoryMEditClient } from '../../medit/client';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function fakeTreeSync() {
  return { refresh: vi.fn(), workingTreeStateOf: vi.fn(), markWorkingTreeState: vi.fn() };
}

// A RecordTypeNode-shaped tree row and its plain-identity equivalent — the two shapes
// `modbench.record.create` must resolve to the same call.
const RECORD_TYPE_NODE = { kind: 'recordType', plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' };
const RECORD_TYPE_IDENTITY = { plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' };

// A RecordNode-shaped tree row and its plain-identity equivalent — what `modbench.record.delete`,
// `.renumber`, `.copyAsOverride` and `.copyAsNewRecord` must all resolve to the same call from.
const RECORD_NODE = {
  kind: 'record', origin: 'ModA',
  record: { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', editorId: null },
};
const RECORD_IDENTITY = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };

describe('recordTypeIdentity / recordIdentity — structural, not node-typed', () => {
  it('reads a RecordTypeNode-shaped row', () => {
    expect(recordTypeIdentity(RECORD_TYPE_NODE)).toEqual({ plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' });
  });

  it('reads a plain identity literal the same way', () => {
    expect(recordTypeIdentity(RECORD_TYPE_IDENTITY)).toEqual({ plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' });
  });

  it('reads a RecordNode-shaped row', () => {
    expect(recordIdentity(RECORD_NODE)).toEqual({ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA', editorId: undefined });
  });

  it('reads a plain identity literal the same way', () => {
    expect(recordIdentity(RECORD_IDENTITY)).toEqual({ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA', editorId: undefined });
  });

  it('is undefined for neither shape', () => {
    expect(recordIdentity({ nothing: true })).toBeUndefined();
    expect(recordTypeIdentity(undefined)).toBeUndefined();
  });
});

describe('registerRecordLifecycleCommands', () => {
  function invoke(client: InMemoryMEditClient) {
    const treeSync = fakeTreeSync();
    const refreshMatchingPlugins = vi.fn();
    registerRecordLifecycleCommands(client, fakeOutputChannel(), treeSync, refreshMatchingPlugins);
    return { treeSync, refreshMatchingPlugins };
  }

  describe('modbench.record.create — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordTypeNode row', RECORD_TYPE_NODE], ['a plain identity literal', RECORD_TYPE_IDENTITY]])(
      'records createRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('createRecord', { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
        invoke(client);

        await handlers.get('modbench.record.create')!(arg);

        expect(client.calls.filter(c => c.method === 'createRecord').map(c => c.args)).toEqual([
          ['MyPatch.esp', 'ModA', 'npc_', undefined, undefined, expect.any(Function)],
        ]);
      });
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a create', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createRecord', {
      refused: true, message: 'mEdit: Could not create a new npc_ record in "MyPatch.esp" — boom',
    });
    const { treeSync, refreshMatchingPlugins } = invoke(client);

    await handlers.get('modbench.record.create')!(RECORD_TYPE_NODE);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not create a new npc_ record in "MyPatch.esp" — boom');
    expect(treeSync.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  describe('modbench.record.delete — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records deleteRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('deleteRecord', { applied: true, formKey: '000801:MyPatch.esp' });
        invoke(client);
        showWarningMessage.mockResolvedValue('Remove');

        await handlers.get('modbench.record.delete')!(arg);

        expect(client.calls.filter(c => c.method === 'deleteRecord').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA'],
        ]);
      });
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a delete', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('deleteRecord', { refused: true, message: 'mEdit: Could not delete 000801:MyPatch.esp — boom' });
    const { treeSync } = invoke(client);
    showWarningMessage.mockResolvedValue('Remove');

    await handlers.get('modbench.record.delete')!(RECORD_NODE);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not delete 000801:MyPatch.esp — boom');
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  describe('modbench.record.renumber — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records renumberRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('renumberRecord', { applied: true, oldFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
        client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
        client.setQueryAnswer('getReferences', []);
        invoke(client);
        showInputBox.mockResolvedValue('000900:MyPatch.esp');
        showWarningMessage.mockResolvedValue(undefined); // zero references — renumberConfirmMessage returns null

        await handlers.get('modbench.record.renumber')!(arg);

        expect(client.calls.filter(c => c.method === 'renumberRecord').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA', '000900:MyPatch.esp'],
        ]);
      });
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a renumber', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('renumberRecord', { refused: true, message: 'mEdit: Could not renumber 000801:MyPatch.esp — boom' });
    client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
    client.setQueryAnswer('getReferences', []);
    const { treeSync } = invoke(client);
    showInputBox.mockResolvedValue('000900:MyPatch.esp');
    showWarningMessage.mockResolvedValue(undefined);

    await handlers.get('modbench.record.renumber')!(RECORD_NODE);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not renumber 000801:MyPatch.esp — boom');
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });
});

describe('registerRecordCopyCommands', () => {
  function invoke(client: InMemoryMEditClient) {
    const treeSync = fakeTreeSync();
    const refreshMatchingPlugins = vi.fn();
    registerRecordCopyCommands(client, fakeOutputChannel(), treeSync, refreshMatchingPlugins);
    return { treeSync, refreshMatchingPlugins };
  }

  function scriptDestinationPick(client: InMemoryMEditClient) {
    client.setQueryAnswer('getPlugins', [{ name: 'MyPatch.esp', origin: 'ModA' } as any]);
    client.setQueryAnswer('getRecordOverridePlugins', []);
    showQuickPick.mockResolvedValue({ label: 'MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } });
  }

  describe('modbench.record.copyAsOverride — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records copyRecordAsOverride from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('copyRecordAsOverride', { applied: true, formKey: '000801:MyPatch.esp' });
        scriptDestinationPick(client);
        invoke(client);

        await handlers.get('modbench.record.copyAsOverride')!(arg);

        expect(client.calls.filter(c => c.method === 'copyRecordAsOverride').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA', 'MyPatch.esp', 'ModA'],
        ]);
      });
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a copy-as-override', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsOverride', {
      refused: true, message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom',
    });
    scriptDestinationPick(client);
    const { treeSync } = invoke(client);

    await handlers.get('modbench.record.copyAsOverride')!(RECORD_NODE);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom');
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  describe('modbench.record.copyAsNewRecord — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records copyRecordAsNewRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('copyRecordAsNewRecord', { applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
        scriptDestinationPick(client);
        invoke(client);

        await handlers.get('modbench.record.copyAsNewRecord')!(arg);

        expect(client.calls.filter(c => c.method === 'copyRecordAsNewRecord').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA', 'MyPatch.esp', 'ModA', undefined, expect.any(Function)],
        ]);
      });
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses a copy-as-new-record', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsNewRecord', {
      refused: true, message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom',
    });
    scriptDestinationPick(client);
    const { treeSync } = invoke(client);

    await handlers.get('modbench.record.copyAsNewRecord')!(RECORD_NODE);

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom');
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });
});
