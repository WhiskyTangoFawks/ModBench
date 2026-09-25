import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a row's handler can be invoked directly — the
// same idiom recordPanelContextCommands.test.ts and pluginRowCommands.test.ts already establish.
// The three message APIs are absent, so a reintroduced direct call throws.
const { handlers, registerCommand, showQuickPick } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick },
}));

import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, recordIdentity, recordTypeIdentity,
} from '../recordLifecycleCommands';
import { InMemoryMEditClient } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { recordingReporter, scriptedDialog, assertAskedOnce } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function fakeTreeSync() {
  return { refresh: vi.fn(), workingTreeStateOf: vi.fn(), markWorkingTreeState: vi.fn() };
}

// A RecordTypeNode-shaped tree row and its plain-identity equivalent — the two shapes
// `modbench.record.create` must resolve to the same call.
const RECORD_TYPE_NODE = { kind: 'recordType', plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' };
const RECORD_TYPE_IDENTITY = { plugin: 'MyPatch.esp', origin: 'ModA', recordType: 'npc_' };

// A RecordNode-shaped tree row and its plain-identity equivalent — what `modbench.record.delete`,
// `.copyAsOverride` and `.copyAsNewRecord` must all resolve to the same call from.
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
  let viewSelection: readonly unknown[] = [];
  function invoke(client: InMemoryMEditClient, ...answers: readonly (string | undefined)[]) {
    const treeSync = fakeTreeSync();
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    registerRecordLifecycleCommands(
      client, new FakeLogOutputChannel(), reporter, ask, treeSync, refreshMatchingPlugins, () => viewSelection);
    return { treeSync, refreshMatchingPlugins, reporter, ask };
  }

  // commands.md, Where: the palette hands the gesture no row, so it takes the Plugins selection.
  describe('from the palette', () => {
    afterEach(() => { viewSelection = []; });

    it('create adds a record of the one selected record type', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('createRecord', { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
      viewSelection = [RECORD_TYPE_NODE];
      invoke(client);

      await present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'")();

      expect(client.calls.filter(c => c.method === 'createRecord').map(c => c.args[2])).toEqual(['npc_']);
    });

    it('delete removes the selected records, asking once', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [RECORD_IDENTITY], refused: [] });
      viewSelection = [RECORD_NODE];
      invoke(client, 'Delete');

      await present(handlers.get('modbench.record.delete'), "the handler registered for 'modbench.record.delete'")();

      expect(client.calls.filter(c => c.method === 'deleteRecords').map(c => c.args[0])).toEqual([
        [{ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' }],
      ]);
    });
  });

  describe('modbench.record.create — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordTypeNode row', RECORD_TYPE_NODE], ['a plain identity literal', RECORD_TYPE_IDENTITY]])(
      'records createRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('createRecord', { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
        invoke(client);

        await present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'")(arg);

        expect(client.calls.filter(c => c.method === 'createRecord').map(c => c.args)).toEqual([
          ['MyPatch.esp', 'ModA', 'npc_', undefined, undefined, expect.any(Function)],
        ]);
      });
  });

  it('lands the added FormKey and refreshes once the create applies', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createRecord', { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
    const { treeSync, refreshMatchingPlugins, reporter } = invoke(client);

    await present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'")(RECORD_TYPE_NODE);

    expect(reporter.landings).toEqual(['Added 000900:MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
    expect(refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast and refreshing on a refusal too would tell the user a record was
  // added that the backend never wrote.
  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a create', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createRecord', {
      refused: true, message: 'Could not create a new npc_ record in "MyPatch.esp" — boom',
    });
    const { treeSync, refreshMatchingPlugins, reporter } = invoke(client);

    await present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'")(RECORD_TYPE_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not create a new npc_ record in "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('reports an unresolvable origin at error and never reaches the backend', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { reporter } = invoke(client);

    await present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'")({ plugin: 'MyPatch.esp', recordType: 'npc_' });

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve which mod "MyPatch.esp" belongs to.', detail: undefined },
    ]);
    expect(client.calls.filter(c => c.method === 'createRecord')).toEqual([]);
  });

  it('asks the ESL-flag question through the injected dialog when the create hits the flag', async () => {
    const client = new InMemoryMEditClient();
    let onEslRefusal: ((message: string) => Promise<boolean>) | undefined;
    client.setCommandHandler('createRecord', (...args) => {
      onEslRefusal = args[5];
      return Promise.resolve({ applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' });
    });
    const { ask } = invoke(client, undefined);

    await present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'")(RECORD_TYPE_NODE);
    const accepted = await present(onEslRefusal, "the ESL-flag refusal callback captured from the command handler")('exhausted the ESL range');

    expect(accepted).toBe(false);
    assertAskedOnce(ask, {
      messageContains: 'Remove the ESL flag and create the record?',
      buttons: ['Remove ESL Flag and Create the Record'],
    });
  });

  describe('modbench.record.delete', () => {
    const deleteRecords = (...args: unknown[]) =>
      present(handlers.get('modbench.record.delete'), "the handler registered for 'modbench.record.delete'")(...args);

    const FIRST = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
    const SECOND = { formKey: '000802:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
    const UNTRACKED = { formKey: '000900:Other.esp', plugin: 'Other.esp', origin: 'ModB' };
    const SECOND_NODE = { kind: 'record', origin: 'ModA', record: { formKey: SECOND.formKey, plugin: SECOND.plugin, editorId: 'SecondNpc' } };
    const UNTRACKED_NODE = { kind: 'record', origin: 'ModB', record: { formKey: UNTRACKED.formKey, plugin: UNTRACKED.plugin, editorId: null } };
    const deleteCalls = (client: InMemoryMEditClient) => client.calls.filter(c => c.method === 'deleteRecords').map(c => c.args);

    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'sends the clicked record alone from %s when no selection comes with it', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('deleteRecords', { landed: [FIRST], refused: [] });
        invoke(client, 'Delete');

        await deleteRecords(arg);

        expect(deleteCalls(client)).toEqual([[[FIRST]]]);
      });

    it('sends the whole selection as one call', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST, UNTRACKED, SECOND], refused: [] });
      invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, UNTRACKED_NODE, SECOND_NODE]);

      expect(deleteCalls(client)).toEqual([[[FIRST, UNTRACKED, SECOND]]]);
    });

    it('asks once, listing every selected record with its plugin and origin, in working-tree words', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST, UNTRACKED, SECOND], refused: [] });
      const { ask } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, UNTRACKED_NODE, SECOND_NODE]);

      expect(ask.asked).toEqual([{
        message: 'Delete 3 records? They leave their plugin source as working-tree changes you can review.',
        detail: '000801:MyPatch.esp in MyPatch.esp (ModA)\n'
          + '000900:Other.esp in Other.esp (ModB)\n'
          + 'SecondNpc [000802:MyPatch.esp] in MyPatch.esp (ModA)',
        buttons: ['Delete'],
      }]);
    });

    it('names a lone record in the question itself, in working-tree words', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [SECOND], refused: [] });
      const { ask } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE);

      expect(ask.asked).toEqual([{
        message: 'Delete SecondNpc [000802:MyPatch.esp] in MyPatch.esp (ModA)? '
          + 'It leaves its plugin source as a working-tree change you can review.',
        detail: undefined,
        buttons: ['Delete'],
      }]);
    });

    // The rival: deleting whatever the dialog answered would make the native cancel delete the selection.
    it('deletes nothing and says nothing when the confirmation is cancelled', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST, SECOND], refused: [] });
      const { treeSync, reporter } = invoke(client, undefined);

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(deleteCalls(client)).toEqual([]);
      expect(treeSync.refresh).not.toHaveBeenCalled();
      expect(reporter.reports).toEqual([]);
    });

    it('reports a partial answer once, naming the refused record and why, and refreshes for the ones that landed', async () => {
      const client = new InMemoryMEditClient();
      const outcome = {
        landed: [FIRST, SECOND],
        refused: [{ item: UNTRACKED, reason: 'Other.esp is not tracked, so it is read-only.' }],
      };
      client.setCommandResult('deleteRecords', outcome);
      const { treeSync, reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, UNTRACKED_NODE, SECOND_NODE]);

      expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not remove 1 of 3 records.', outcome }]);
      expect(reporter.reports).toEqual([{
        severity: 'error',
        message: 'Could not remove 1 of 3 records.',
        detail: '"000900:Other.esp in Other.esp (ModB)" (Other.esp is not tracked, so it is read-only.)',
      }]);
      expect(treeSync.refresh).toHaveBeenCalledOnce();
    });

    it('says nothing when every record landed', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST, SECOND], refused: [] });
      const { treeSync, reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
      expect(treeSync.refresh).toHaveBeenCalledOnce();
    });

    it('refreshes nothing when every record was refused', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [], refused: [{ item: UNTRACKED, reason: 'not tracked' }] });
      const { treeSync } = invoke(client, 'Delete');

      await deleteRecords(UNTRACKED_NODE);

      expect(treeSync.refresh).not.toHaveBeenCalled();
    });

    it('reports the ready-to-show message at error and refreshes nothing when the call itself fails', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { refused: true, message: 'Could not delete 2 records — boom' });
      const { treeSync, reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(reporter.reports).toEqual([
        { severity: 'error', message: 'Could not delete 2 records — boom', detail: undefined },
      ]);
      expect(treeSync.refresh).not.toHaveBeenCalled();
    });

    it('refuses a record whose mod cannot be resolved, and still sends the rest', async () => {
      const client = new InMemoryMEditClient();
      client.setQueryAnswer('getPlugins', []);
      client.setCommandResult('deleteRecords', { landed: [FIRST], refused: [] });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(RECORD_NODE, [RECORD_NODE, { formKey: '000700:Lost.esp', plugin: 'Lost.esp' }]);

      expect(deleteCalls(client)).toEqual([[[FIRST]]]);
      expect(reporter.reports).toEqual([{
        severity: 'error',
        message: 'Could not remove 1 of 2 records.',
        detail: '"000700:Lost.esp in Lost.esp" (could not resolve which mod it belongs to)',
      }]);
    });
  });
});

describe('registerRecordCopyCommands', () => {
  function invoke(client: InMemoryMEditClient) {
    const treeSync = fakeTreeSync();
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    registerRecordCopyCommands(client, new FakeLogOutputChannel(), reporter, treeSync, refreshMatchingPlugins);
    return { treeSync, refreshMatchingPlugins, reporter };
  }

  function scriptDestinationPick(client: InMemoryMEditClient) {
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'MyPatch.esp', origin: 'ModA' })]);
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

        await present(handlers.get('modbench.record.copyAsOverride'), "the handler registered for 'modbench.record.copyAsOverride'")(arg);

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

    await present(handlers.get('modbench.record.copyAsOverride'), "the handler registered for 'modbench.record.copyAsOverride'")(RECORD_NODE);

    expect(reporter.landings).toEqual(['Copied 000801:MyPatch.esp into MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a copy-as-override', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsOverride', {
      refused: true, message: 'Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom',
    });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await present(handlers.get('modbench.record.copyAsOverride'), "the handler registered for 'modbench.record.copyAsOverride'")(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  it('tells the user when no plugin is eligible, and picks nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getRecordOverridePlugins', []);
    const { reporter } = invoke(client);

    await present(handlers.get('modbench.record.copyAsOverride'), "the handler registered for 'modbench.record.copyAsOverride'")(RECORD_NODE);

    expect(reporter.landings).toEqual(['No eligible destination plugin for this copy.']);
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('reports a failed destination lookup at error, with its reason as the detail', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'MyPatch.esp', origin: 'ModA' })]);
    client.setQueryFailure('getRecordOverridePlugins', new Error('backend down'));
    const { reporter } = invoke(client);

    await present(handlers.get('modbench.record.copyAsOverride'), "the handler registered for 'modbench.record.copyAsOverride'")(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not look up destination plugins.', detail: 'backend down' },
    ]);
  });

  describe('modbench.record.copyAsNewRecord — a tree node and a plain identity record the same call', () => {
    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY]])(
      'records copyRecordAsNewRecord from %s', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('copyRecordAsNewRecord', { applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
        scriptDestinationPick(client);
        invoke(client);

        await present(handlers.get('modbench.record.copyAsNewRecord'), "the handler registered for 'modbench.record.copyAsNewRecord'")(arg);

        expect(client.calls.filter(c => c.method === 'copyRecordAsNewRecord').map(c => c.args)).toEqual([
          ['000801:MyPatch.esp', 'MyPatch.esp', 'ModA', 'MyPatch.esp', 'ModA', undefined],
        ]);
      });
  });

  it('lands the new FormKey and its destination once the copy-as-new-record applies', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsNewRecord', { applied: true, sourceFormKey: '000801:MyPatch.esp', newFormKey: '000900:MyPatch.esp' });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await present(handlers.get('modbench.record.copyAsNewRecord'), "the handler registered for 'modbench.record.copyAsNewRecord'")(RECORD_NODE);

    expect(reporter.landings).toEqual(['Copied as 000900:MyPatch.esp into MyPatch.esp.']);
    expect(treeSync.refresh).toHaveBeenCalledOnce();
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses a copy-as-new-record', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('copyRecordAsNewRecord', {
      refused: true, message: 'Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom',
    });
    scriptDestinationPick(client);
    const { treeSync, reporter } = invoke(client);

    await present(handlers.get('modbench.record.copyAsNewRecord'), "the handler registered for 'modbench.record.copyAsNewRecord'")(RECORD_NODE);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not copy 000801:Fallout4.esm into "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeSync.refresh).not.toHaveBeenCalled();
  });

  // xedit.md divergence 5.
  it('reports a no-free-FormID refusal as a plain error, and never asks the ESL-flag question', async () => {
    const client = new InMemoryMEditClient();
    const refusalMessage = 'Could not copy 000801:MyPatch.esp into "MyPatch.esp" — MyPatch.esp has ' +
      'exhausted its FormKey space — every local FormID up to 0xFFFFFF is already in use. Clear the light ' +
      'flag in the header, or change a record\'s FormID.';
    let capturedCallback: unknown;
    client.setCommandHandler('copyRecordAsNewRecord', (...args) => {
      capturedCallback = args[6];
      return Promise.resolve({ refused: true, message: refusalMessage });
    });
    scriptDestinationPick(client);
    const { reporter } = invoke(client);

    await present(handlers.get('modbench.record.copyAsNewRecord'), "the handler registered for 'modbench.record.copyAsNewRecord'")(RECORD_NODE);

    expect(capturedCallback).toBeUndefined();
    expect(reporter.reports).toEqual([{ severity: 'error', message: refusalMessage, detail: undefined }]);
  });
});
