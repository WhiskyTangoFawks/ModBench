import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a row's handler can be invoked directly — the
// same idiom recordPanelContextCommands.test.ts and pluginRowCommands.test.ts already establish.
// The three message APIs are deliberately absent from the mock: this module surfaces through the
// injected reporter and dialog, so a reintroduced direct call throws here instead of passing.
const { handlers, registerCommand, showInputBox, showQuickPick } = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showInputBox, showQuickPick },
}));

import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, recordIdentity, recordTypeIdentity,
} from '../recordLifecycleCommands';
import { InMemoryMEditClient } from '../../medit/client';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';

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
  function invoke(client: InMemoryMEditClient, ...answers: readonly (string | undefined)[]) {
    const treeSync = fakeTreeSync();
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    registerRecordLifecycleCommands(client, fakeOutputChannel(), reporter, ask, treeSync, refreshMatchingPlugins);
    return { treeSync, refreshMatchingPlugins, reporter, ask };
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

  it('lands the added FormKey and refreshes once the create applies', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createRecord', { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
    const { treeSync, refreshMatchingPlugins, reporter } = invoke(client);

    await handlers.get('modbench.record.create')!(RECORD_TYPE_NODE);

    expect(reporter.landings).toEqual(['Added 000900:MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
    expect(refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast and refreshing on a refusal too would tell the user a record was
  // added that the backend never wrote.
  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a create', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createRecord', {
      refused: true, message: 'mEdit: Could not create a new npc_ record in "MyPatch.esp" — boom',
    });
    const { treeSync, refreshMatchingPlugins, reporter } = invoke(client);

    await handlers.get('modbench.record.create')!(RECORD_TYPE_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not create a new npc_ record in "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('reports an unresolvable origin at error and never reaches the backend', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { reporter } = invoke(client);

    await handlers.get('modbench.record.create')!({ plugin: 'MyPatch.esp', recordType: 'npc_' });

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve which mod "MyPatch.esp" belongs to.', detail: undefined },
    ]);
    expect(client.calls.filter(c => c.method === 'createRecord')).toEqual([]);
  });

  it('asks the ESL-flag question through the injected dialog when the create hits the flag', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createRecord', { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
    const { ask } = invoke(client, undefined);

    await handlers.get('modbench.record.create')!(RECORD_TYPE_NODE);
    const onEslRefusal = client.calls.find(c => c.method === 'createRecord')!.args[5] as (m: string) => Promise<boolean>;
    const accepted = await onEslRefusal('exhausted the ESL range');

    expect(accepted).toBe(false);
    expect(ask.asked).toEqual([{
      message: expect.stringContaining('Remove the ESL flag and create the record?'),
      detail: undefined,
      buttons: ['Remove ESL Flag and Create the Record'],
    }]);
  });

  describe('modbench.record.delete — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records deleteRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('deleteRecord', { applied: true, formKey: '000801:MyPatch.esp' });
        invoke(client, 'Remove');

        await handlers.get('modbench.record.delete')!(arg);

        expect(client.calls.filter(c => c.method === 'deleteRecord').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA'],
        ]);
      });
  });

  it('asks the removal confirmation through the injected dialog, naming the record xEdit names', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('deleteRecord', { applied: true, formKey: '000801:MyPatch.esp' });
    const { ask } = invoke(client, 'Remove');

    await handlers.get('modbench.record.delete')!({ ...RECORD_NODE, record: { ...RECORD_NODE.record, editorId: 'MyNpc' } });

    expect(ask.asked).toEqual([{
      message: 'Are you sure you want to permanently remove MyNpc [000801:MyPatch.esp]?',
      detail: undefined,
      buttons: ['Remove'],
    }]);
  });

  // The rival: deleting whatever the dialog answered would make the native cancel delete the record.
  it('deletes nothing when the confirmation is cancelled', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('deleteRecord', { applied: true, formKey: '000801:MyPatch.esp' });
    const { treeSync } = invoke(client, undefined);

    await handlers.get('modbench.record.delete')!(RECORD_NODE);

    expect(client.calls.filter(c => c.method === 'deleteRecord')).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a delete', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('deleteRecord', { refused: true, message: 'mEdit: Could not delete 000801:MyPatch.esp — boom' });
    const { treeSync, reporter } = invoke(client, 'Remove');

    await handlers.get('modbench.record.delete')!(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not delete 000801:MyPatch.esp — boom', detail: undefined },
    ]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  describe('modbench.record.renumber — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records renumberRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('renumberRecord', { applied: true, oldFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
        client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
        client.setQueryAnswer('getReferences', []);
        invoke(client); // zero references — renumberConfirmMessage returns null, so nothing is asked
        showInputBox.mockResolvedValue('000900:MyPatch.esp');

        await handlers.get('modbench.record.renumber')!(arg);

        expect(client.calls.filter(c => c.method === 'renumberRecord').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA', '000900:MyPatch.esp'],
        ]);
      });
  });

  it('lands the new FormKey once the renumber applies', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('renumberRecord', { applied: true, oldFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
    client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
    client.setQueryAnswer('getReferences', []);
    const { treeSync, reporter } = invoke(client);
    showInputBox.mockResolvedValue('000900:MyPatch.esp');

    await handlers.get('modbench.record.renumber')!(RECORD_NODE);

    expect(reporter.landings).toEqual(['Renumbered to 000900:MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
  });

  it('asks the blast-radius confirmation through the injected dialog when the record has referencers', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('renumberRecord', { applied: true, oldFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
    client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
    client.setQueryAnswer('getReferences', [{ formKey: '000701:Other.esp' } as any]);
    const { ask } = invoke(client, 'Change FormID');
    showInputBox.mockResolvedValue('000900:MyPatch.esp');

    await handlers.get('modbench.record.renumber')!(RECORD_NODE);

    expect(ask.asked).toEqual([{
      message: expect.stringContaining('000801:MyPatch.esp'),
      detail: undefined,
      buttons: ['Change FormID'],
    }]);
  });

  // The rival: renumbering whatever the dialog answered would cascade the change over every
  // referencer the user just declined to touch.
  it('renumbers nothing when the blast-radius confirmation is cancelled', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
    client.setQueryAnswer('getReferences', [{ formKey: '000701:Other.esp' } as any]);
    invoke(client, undefined);
    showInputBox.mockResolvedValue('000900:MyPatch.esp');

    await handlers.get('modbench.record.renumber')!(RECORD_NODE);

    expect(client.calls.filter(c => c.method === 'renumberRecord')).toEqual([]);
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a renumber', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('renumberRecord', { refused: true, message: 'mEdit: Could not renumber 000801:MyPatch.esp — boom' });
    client.setQueryAnswer('peekNextFreeFormKey', '000900:MyPatch.esp');
    client.setQueryAnswer('getReferences', []);
    const { treeSync, reporter } = invoke(client);
    showInputBox.mockResolvedValue('000900:MyPatch.esp');

    await handlers.get('modbench.record.renumber')!(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not renumber 000801:MyPatch.esp — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });
});

describe('registerRecordCopyCommands', () => {
  function invoke(client: InMemoryMEditClient, ...answers: readonly (string | undefined)[]) {
    const treeSync = fakeTreeSync();
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    registerRecordCopyCommands(client, fakeOutputChannel(), reporter, ask, treeSync, refreshMatchingPlugins);
    return { treeSync, refreshMatchingPlugins, reporter, ask };
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

  it('lands the copied record and its destination once the copy-as-override applies', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsOverride', { applied: true, formKey: '000801:MyPatch.esp' });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await handlers.get('modbench.record.copyAsOverride')!(RECORD_NODE);

    expect(reporter.landings).toEqual(['Copied 000801:MyPatch.esp into MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a copy-as-override', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsOverride', {
      refused: true, message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom',
    });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await handlers.get('modbench.record.copyAsOverride')!(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  it('tells the user when no plugin is eligible, and picks nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getRecordOverridePlugins', []);
    const { reporter } = invoke(client);

    await handlers.get('modbench.record.copyAsOverride')!(RECORD_NODE);

    expect(reporter.landings).toEqual(['No eligible destination plugin for this copy.']);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('reports a failed destination lookup at error, with the gesture as the log detail', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [{ name: 'MyPatch.esp', origin: 'ModA' } as any]);
    client.setQueryFailure('getRecordOverridePlugins', new Error('backend down'));
    const { reporter } = invoke(client);

    await handlers.get('modbench.record.copyAsOverride')!(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not look up destination plugins: backend down', detail: 'copy-as-override' },
    ]);
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

  it('lands the new FormKey and its destination once the copy-as-new-record applies', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsNewRecord', { applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await handlers.get('modbench.record.copyAsNewRecord')!(RECORD_NODE);

    expect(reporter.landings).toEqual(['Copied as 000900:MyPatch.esp into MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a copy-as-new-record', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsNewRecord', {
      refused: true, message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom',
    });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await handlers.get('modbench.record.copyAsNewRecord')!(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  it('asks the ESL-flag question through the injected dialog when the copy hits the flag', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsNewRecord', { applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
    scriptDestinationPick(client);
    const { ask } = invoke(client, undefined);

    await handlers.get('modbench.record.copyAsNewRecord')!(RECORD_NODE);
    const onEslRefusal = client.calls.find(c => c.method === 'copyRecordAsNewRecord')!.args[6] as (m: string) => Promise<boolean>;
    const accepted = await onEslRefusal('exhausted the ESL range');

    expect(accepted).toBe(false);
    expect(ask.asked).toEqual([{
      message: expect.stringContaining('Remove the ESL flag and copy the record?'),
      detail: undefined,
      buttons: ['Remove ESL Flag and Copy the Record'],
    }]);
  });
});
