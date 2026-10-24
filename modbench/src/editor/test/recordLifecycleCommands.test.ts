import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { CopyItem, RecordAt } from '../../client';
import type { ItemRefusal } from '../../ports/selectionOutcome';
import type { SourceEditing } from '../../textDocuments/sourceEditing';

interface PickItem { label: string; description?: string; mode?: string; plugin?: { name: string } }
type ShowQuickPick = (items: readonly PickItem[], options?: { canPickMany?: boolean }) => Promise<unknown>;

const { handlers, registerCommand, executeCommand, showQuickPick } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    executeCommand: vi.fn((command: string, ...args: unknown[]) => handlers.get(command)?.(...args)),
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn<ShowQuickPick>(),
  };
});

vi.mock('vscode', async () => {
  const { TreeItem, TreeItemCollapsibleState } = await import('../../test/vscodeMock');
  return {
    commands: { registerCommand, executeCommand },
    window: { showQuickPick },
    TreeItem, TreeItemCollapsibleState,
  };
});

import { TreeItem } from '../../test/vscodeMock';
import {
  registerRecordLifecycleCommands, registerRecordCopyCommands,
} from '../recordLifecycleCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { RecordWrite } from '../../drivingLib/writingGesture';
import { readReferencedBy } from '../referencedByList';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { oneAtATime, type OneAtATime } from '../../textDocuments/oneAtATime';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

const carrying = ({ formKey, plugin }: RecordAt, label?: string) =>
  ({ label, argument: { kind: 'record', plugin, formKey } });

let viewSelection: readonly unknown[] = [];
const selectionsOfViews = new Map<string, readonly unknown[]>();
const selections = { focused: () => viewSelection, of: (view: string) => selectionsOfViews.get(view) ?? [] };

const RECORD_IDENTITY = { formKey: '000801:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
const RECORD_NODE = carrying(RECORD_IDENTITY);

function recordingWrite(): { write: RecordWrite; writing: string[] } {
  const writing: string[] = [];
  return {
    writing,
    write: async (command) => {
      writing.push('opens');
      await command();
      writing.push('ends');
    },
  };
}

async function referencedByCopy(record: RecordAt, editorId: string) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getChildRecordTypes', []);
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...record.plugin, isCompiledPlugin: true, isImmutable: false })]);
  client.setQueryAnswer('getReferences', [{
    formKey: record.formKey, plugin: record.plugin.name, origin: record.plugin.origin, fieldPath: 'Keywords[0]',
    recordType: 'npc_', recordTypeName: 'Non-Player Character', editorId,
  }]);
  const { provider } = await readReferencedBy(client, '000001:A.esp', 'a list');
  const [referrer] = provider.getChildren();
  const [copy] = provider.getChildren(present(referrer, 'the referrer'));
  return present(copy, 'its plugin copy');
}

const changes = (record: RecordAt) => ({ record, moves: [], deletions: [], documents: [] });

type RegisterCommands = (
  client: InMemoryMEditClient, ...rest: Parameters<typeof registerRecordLifecycleCommands> extends [unknown, ...infer Rest] ? Rest : never
) => unknown;

function invoking(register: RegisterCommands) {
  return (client: InMemoryMEditClient, ...answers: readonly (string | undefined)[]) => {
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    const { write, writing } = recordingWrite();
    const source = {
      applyWorkspaceChanges: vi.fn<SourceEditing['applyWorkspaceChanges']>(() => Promise.resolve()), oneAtATime: oneAtATime(), refreshSourceControlFor: vi.fn(),
    };
    register(client, reporter, ask, selections, write, source);
    return { reporter, ask, writing, source };
  };
}

function editInFlight(source: { oneAtATime: OneAtATime }): () => void {
  let settle!: () => void;
  void source.oneAtATime(() => new Promise<void>((resolve) => { settle = resolve; }));
  return () => { settle(); };
}

const asked = (client: InMemoryMEditClient, method: string) => client.calls.filter((c) => c.method === method);

describe('registerRecordLifecycleCommands', () => {
  const invoke = invoking(registerRecordLifecycleCommands);

  describe('a view\'s Delete key, which passes its view as args', () => {
    afterEach(() => { selectionsOfViews.clear(); });

    it('deletes the selection of the view it is bound in, not the view last selected in', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [].map(changes), refused: [] });
      viewSelection = [carrying({ formKey: '000900:Other.esp', plugin: { name: 'Other.esp', origin: 'ModB' } })];
      selectionsOfViews.set('modbench.pluginListTree', [RECORD_NODE]);
      invoke(client, 'Delete');

      await present(handlers.get('modbench.record.delete'), 'the delete command')({ view: 'modbench.pluginListTree' });

      expect(client.calls.filter(c => c.method === 'getDeleteChanges').map(c => c.args[0])).toEqual([[RECORD_IDENTITY]]);
    });

    it('deletes nothing with nothing selected in its view, rather than fall back to another view', async () => {
      const client = new InMemoryMEditClient();
      viewSelection = [RECORD_NODE];
      invoke(client, 'Delete');

      await present(handlers.get('modbench.record.delete'), 'the delete command')({ view: 'modbench.pluginListTree' });

      expect(client.calls.filter(c => c.method === 'getDeleteChanges')).toEqual([]);
    });
  });

  describe('modbench.record.delete', () => {
    const deleteRecords = (...args: unknown[]) =>
      present(handlers.get('modbench.record.delete'), "the handler registered for 'modbench.record.delete'")(...args);

    const FIRST = { formKey: '000801:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
    const SECOND = { formKey: '000802:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
    const NON_COMPILED_PLUGIN = { formKey: '000900:Other.esp', plugin: { name: 'Other.esp', origin: 'ModB' } };
    const SECOND_NODE = carrying(SECOND, 'SecondNpc');
    const NON_COMPILED_PLUGIN_NODE = carrying(NON_COMPILED_PLUGIN);
    const deleteCalls = (client: InMemoryMEditClient) => client.calls.filter(c => c.method === 'getDeleteChanges').map(c => c.args[0]);

    const COLUMN_HEADER = { webviewSection: 'recordHeader', ...carrying(FIRST), editable: true, preventDefaultContextMenuItems: true };

    it.each([['a row', RECORD_NODE], ['the Editor\'s column header', COLUMN_HEADER]])(
      'sends the clicked record alone from %s when no selection comes with it', async (_label, arg) => {
        const client = new InMemoryMEditClient();
        client.setCommandResult('getDeleteChanges', { applied: [FIRST].map(changes), refused: [] });
        invoke(client, 'Delete');

        await deleteRecords(arg);

        expect(deleteCalls(client)).toEqual([[FIRST]]);
      });

    it.each(['worldspace', 'cell', 'placed'])('names a %s row\'s record by the FormKey and EditorID the row states beside its plugin', async (kind) => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [SECOND].map(changes), refused: [] });
      const { ask } = invoke(client, 'Delete');

      await deleteRecords({ kind, ...carrying(SECOND, 'Here') });

      expect(deleteCalls(client)).toEqual([[SECOND]]);
      expect(ask.asked.map((question) => question.message)).toEqual([
        'Delete Here [000802:MyPatch.esp] in MyPatch.esp (ModA)? It leaves its plugin source as a working-tree change you can review.',
      ]);
    });

    it('names the plugin copy a Referenced By row stands for, with its origin and the EditorID of the record it holds', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [SECOND].map(changes), refused: [] });
      const { ask } = invoke(client, 'Delete');
      const holder = await referencedByCopy(SECOND, 'TestNPC');

      await deleteRecords(holder);

      expect(deleteCalls(client)).toEqual([[SECOND]]);
      expect(ask.asked.map((question) => question.message)).toEqual([
        'Delete TestNPC [000802:MyPatch.esp] in MyPatch.esp (ModA)? It leaves its plugin source as a working-tree change you can review.',
      ]);
    });

    it('asks nothing, deletes nothing and says so for a row that carries no record Argument', async () => {
      const client = new InMemoryMEditClient();
      const { ask, reporter } = invoke(client, 'Delete');
      const withoutArgument = Object.assign(new TreeItem('Armor'), { kind: 'record', origin: 'ModA', record: { formKey: FIRST.formKey, plugin: FIRST.plugin } });

      await deleteRecords(withoutArgument);

      expect(ask.asked).toEqual([]);
      expect(deleteCalls(client)).toEqual([]);
      expect(reporter.reports).toEqual([{
        severity: 'error', message: 'Could not delete 1 of 1 records.', detail: '"Armor" (it carries no record Argument)',
      }]);
    });

    it('refuses a record that names no plugin, since a FormKey alone names no one copy', async () => {
      const client = new InMemoryMEditClient();
      const { ask, reporter } = invoke(client, 'Delete');

      await deleteRecords({ label: 'Gun', argument: { kind: 'record', formKey: FIRST.formKey } });

      expect(ask.asked).toEqual([]);
      expect(deleteCalls(client)).toEqual([]);
      expect(reporter.reports).toEqual([{
        severity: 'error', message: 'Could not delete 1 of 1 records.', detail: '"Gun" (it names no plugin)',
      }]);
    });

    it('sends the whole selection as one call', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [FIRST, NON_COMPILED_PLUGIN, SECOND].map(changes), refused: [] });
      invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, NON_COMPILED_PLUGIN_NODE, SECOND_NODE]);

      expect(deleteCalls(client)).toEqual([[FIRST, NON_COMPILED_PLUGIN, SECOND]]);
    });

    it('asks once, listing every selected record with its plugin and origin, in working-tree words', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [FIRST, NON_COMPILED_PLUGIN, SECOND].map(changes), refused: [] });
      const { ask } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, NON_COMPILED_PLUGIN_NODE, SECOND_NODE]);

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
      client.setCommandResult('getDeleteChanges', { applied: [SECOND].map(changes), refused: [] });
      const { ask } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE);

      expect(ask.asked).toEqual([{
        message: 'Delete SecondNpc [000802:MyPatch.esp] in MyPatch.esp (ModA)? '
          + 'It leaves its plugin source as a working-tree change you can review.',
        detail: undefined,
        buttons: ['Delete'],
      }]);
    });

    it('deletes nothing and says nothing when the confirmation is cancelled, rather than deleting whatever the dialog answered', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [FIRST, SECOND].map(changes), refused: [] });
      const { reporter } = invoke(client, undefined);

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(deleteCalls(client)).toEqual([]);
      expect(reporter.reports).toEqual([]);
    });

    it('reports a partial answer once, naming the refused record and why', async () => {
      const client = new InMemoryMEditClient();
      const outcome = {
        landed: [FIRST, SECOND],
        refused: [{ item: NON_COMPILED_PLUGIN, reason: 'Other.esp is not a compiled plugin, so it is read-only.' }],
      };
      client.setCommandResult('getDeleteChanges', { applied: outcome.landed.map(changes), refused: outcome.refused });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, NON_COMPILED_PLUGIN_NODE, SECOND_NODE]);

      expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not delete 1 of 3 records.', outcome }]);
      expect(reporter.reports).toEqual([{
        severity: 'error',
        message: 'Could not delete 1 of 3 records.',
        detail: '"000900:Other.esp in Other.esp (ModB)" (Other.esp is not a compiled plugin, so it is read-only.)',
      }]);
    });

    it('refuses a row that carries no record Argument, naming it, and still deletes the rest', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [FIRST].map(changes), refused: [] });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(RECORD_NODE, [RECORD_NODE, { label: 'Lost.esp', formKey: '000700:Lost.esp', plugin: 'Lost.esp', origin: 'ModA' }]);

      expect(deleteCalls(client)).toEqual([[FIRST]]);
      expect(reporter.reports).toEqual([{
        severity: 'error',
        message: 'Could not delete 1 of 2 records.',
        detail: '"Lost.esp" (it carries no record Argument)',
      }]);
    });

    it('says nothing when every record landed', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [FIRST, SECOND].map(changes), refused: [] });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
    });

    it('reports the ready-to-show message at error when the call itself fails', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { refused: true, message: 'Could not delete 2 records — boom' });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(reporter.reports).toEqual([
        { severity: 'error', message: 'Could not delete 2 records — boom', detail: undefined },
      ]);
    });

    it('makes what mEdit answered as one workspace edit, then refreshes Source Control once for each plugin it changed', async () => {
      const client = new InMemoryMEditClient();
      const answered = [changes(FIRST), changes(SECOND), changes(NON_COMPILED_PLUGIN)];
      client.setCommandResult('getDeleteChanges', { applied: answered, refused: [] });
      const { source } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE, NON_COMPILED_PLUGIN_NODE]);

      expect(source.applyWorkspaceChanges.mock.calls).toEqual([[answered]]);
      expect(source.refreshSourceControlFor.mock.calls).toEqual([
        [{ name: 'MyPatch.esp', origin: 'ModA' }], [{ name: 'Other.esp', origin: 'ModB' }],
      ]);
    });

    it('reports a workspace edit VS Code did not make as one that may have partly landed, lands none, refreshes Source Control, and still names the records mEdit refused', async () => {
      const client = new InMemoryMEditClient();
      const refusal = { item: NON_COMPILED_PLUGIN, reason: 'Other.esp is not a compiled plugin, so it is read-only.' };
      client.setCommandResult('getDeleteChanges', { applied: [changes(FIRST)], refused: [refusal] });
      const { reporter, source } = invoke(client, 'Delete');
      source.applyWorkspaceChanges.mockRejectedValue(new Error('VS Code did not apply the changes.'));

      await deleteRecords(SECOND_NODE, [RECORD_NODE, NON_COMPILED_PLUGIN_NODE]);

      expect(reporter.reports[0]).toEqual(
        { severity: 'error', message: 'Could not delete the records.', detail: "VS Code did not apply the changes. VS Code stops at the first change it cannot make, so some changes may have landed." });
      expect(reporter.selectionOutcomeCalls).toEqual([
        { message: 'Could not delete 1 of 2 records.', outcome: { landed: [], refused: [refusal] } },
      ]);
      expect(source.refreshSourceControlFor).toHaveBeenCalledWith({ name: 'MyPatch.esp', origin: 'ModA' });
    });

    it('runs the whole delete after the edits in flight settle', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { applied: [], refused: [] });
      const { source, writing } = invoke(client, 'Delete');
      const settle = editInFlight(source);

      const deleting = deleteRecords(SECOND_NODE);
      await vi.waitFor(() => expect(writing).toEqual(['opens']));
      expect(asked(client, 'getDeleteChanges')).toEqual([]);
      settle();
      await deleting;

      expect(asked(client, 'getDeleteChanges')).toHaveLength(1);
    });

    it('runs the delete inside the write, which ends when the call is answered', async () => {
      const client = new InMemoryMEditClient();
      const { writing } = invoke(client, 'Delete');
      client.setCommandHandler('getDeleteChanges', () => {
        writing.push('delete');
        return Promise.resolve({ applied: [changes(FIRST)], refused: [{ item: SECOND, reason: 'no' }] });
      });

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(writing).toEqual(['opens', 'delete', 'ends']);
    });

    it('opens no write when the question is declined', async () => {
      const client = new InMemoryMEditClient();
      const { writing } = invoke(client, undefined);

      await deleteRecords(SECOND_NODE);

      expect(writing).toEqual([]);
    });

    it('ends the write after mEdit refuses the call, and reports it', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('getDeleteChanges', { refused: true, message: 'Could not delete 1 record — socket hang up' });
      const { writing, reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE);

      expect(writing).toEqual(['opens', 'ends']);
      expect(reporter.reports).toEqual([
        { severity: 'error', message: 'Could not delete 1 record — socket hang up', detail: undefined },
      ]);
    });
  });
});

describe('modbench.record.copy, one command over the selection: the mode picked, then the destinations', () => {
  const SOURCE = { formKey: '000801:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
  const SECOND = { formKey: '000802:MyPatch.esp', plugin: { name: 'MyPatch.esp', origin: 'ModA' } };
  const SECOND_NODE = carrying(SECOND, 'Second');
  const PATCH = { name: 'Patch.esp', origin: 'PatchMod' };
  const OTHER = { name: 'Other.esp', origin: 'OtherMod' };
  const HEADER = { webviewSection: 'recordHeader', ...carrying(SOURCE), editable: true, preventDefaultContextMenuItems: true };

  afterEach(() => { viewSelection = []; });
  beforeEach(function dropUnansweredPicksSoTheyDoNotAnswerTheNextTest() { showQuickPick.mockReset(); });

  const copyChanges = (record: RecordAt, destination: { name: string; origin: string }) =>
    ({ record, destination, moves: [], deletions: [], documents: [] });

  const invoke = invoking(registerRecordCopyCommands);

  const copy = (...args: unknown[]) =>
    present(handlers.get('modbench.record.copy'), "the handler registered for 'modbench.record.copy'")(...args);

  function destinations(client: InMemoryMEditClient) {
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: 'MyPatch.esp', origin: 'ModA', loadOrderIndex: 2, isCompiledPlugin: true }),
      pluginMetadataFixture({ name: 'Patch.esp', origin: 'PatchMod', loadOrderIndex: 4, isCompiledPlugin: true }),
      pluginMetadataFixture({ name: 'Other.esp', origin: 'OtherMod', loadOrderIndex: 6, isCompiledPlugin: true }),
    ]);
  }

  function pick(mode: 'Override' | 'New' | undefined, picked?: readonly { name: string; origin: string }[]) {
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(items.find((item) => item.mode === mode)));
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(picked && items.filter((item) => picked.some((p) => p.name === item.plugin?.name))));
  }

  const copyCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'getCopyChanges').map((c) => c.args);

  it.each([['a row', RECORD_NODE], ['the Editor\'s record header', HEADER]])(
    'copies the record %s names into every destination picked, in the mode picked', async (_what, arg) => {
      const client = new InMemoryMEditClient();
      destinations(client);
      client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
      pick('New', [PATCH, OTHER]);
      invoke(client);

      await copy(arg);

      expect(copyCalls(client)).toEqual([[[SOURCE], 'New', [PATCH, OTHER], false]]);
    });

  it('refuses a row that carries no record Argument, naming it, and still copies the rest', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
    pick('New', [PATCH]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE, [RECORD_NODE, { label: 'Lost.esp', formKey: '000700:Lost.esp', plugin: 'Lost.esp', origin: 'ModA' }]);

    expect(copyCalls(client)).toEqual([[[SOURCE], 'New', [PATCH], false]]);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not copy 1 of 2 records.',
      detail: '"Lost.esp" (it carries no record Argument)',
    }]);
  });

  it('takes the whole selection when the right-clicked row is one of several selected', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
    pick('New', [PATCH]);
    invoke(client);

    await copy(RECORD_NODE, [RECORD_NODE, SECOND_NODE]);

    expect(copyCalls(client)).toEqual([[[SOURCE, SECOND], 'New', [PATCH], false]]);
  });

  it('asks for the destinations in one pick of many, each with its load position', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    pick('New', undefined);
    invoke(client);

    await copy(RECORD_NODE);

    const [items, options] = present(showQuickPick.mock.calls[1], 'the destination pick');
    expect(options?.canPickMany).toBe(true);
    expect(items.map(({ label, description }) => `${label} ${description ?? ''}`))
      .toEqual(['MyPatch.esp [2]', 'Patch.esp [4]', 'Other.esp [6]']);
  });

  it.each([
    ['the mode', () => { pick(undefined); }],
    ['the destinations', () => { pick('New', undefined); }],
    ['the destinations, with none picked', () => { pick('New', []); }],
  ])('Esc on %s copies nothing and says nothing', async (_what, answer) => {
    const client = new InMemoryMEditClient();
    destinations(client);
    answer();
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(copyCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('asks once, for the whole selection, to replace every copy the picked destinations already hold, then copies with replace', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setQueryAnswerOnce('getRecordHolders', [{ name: 'MyPatch.esp', origin: 'ModA' }, PATCH]);
    client.setQueryAnswerOnce('getRecordHolders', [{ name: 'MyPatch.esp', origin: 'ModA' }, PATCH, OTHER]);
    client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
    pick('Override', [PATCH, OTHER]);
    const { ask } = invoke(client, 'Replace');

    await copy(RECORD_NODE, [RECORD_NODE, SECOND_NODE]);

    expect(ask.asked).toHaveLength(1);
    const question = present(ask.asked[0], 'the one replace question');
    expect(question.buttons).toEqual(['Replace']);
    expect(question.detail?.split('\n')).toEqual([
      '000801:MyPatch.esp in Patch.esp (PatchMod)',
      'Second [000802:MyPatch.esp] in Patch.esp (PatchMod)',
      'Second [000802:MyPatch.esp] in Other.esp (OtherMod)',
    ]);
    expect(copyCalls(client)).toEqual([[[SOURCE, SECOND], 'Override', [PATCH, OTHER], true]]);
  });

  it('copies nothing when the replacement is not confirmed', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setQueryAnswer('getRecordHolders', [PATCH]);
    pick('Override', [PATCH, OTHER]);
    const { ask, reporter } = invoke(client, undefined);

    await copy(RECORD_NODE);

    expect(ask.asked).toHaveLength(1);
    expect(copyCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('asks nothing when no picked destination holds a copy', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setQueryAnswer('getRecordHolders', [{ name: 'MyPatch.esp', origin: 'ModA' }]);
    client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
    pick('Override', [PATCH]);
    const { ask } = invoke(client);

    await copy(RECORD_NODE);

    expect(ask.asked).toEqual([]);
    expect(copyCalls(client)).toEqual([[[SOURCE], 'Override', [PATCH], false]]);
  });

  it('asks nothing of a record\'s own plugin picked for a mixed selection, which holds the record and no copy to replace, and says nothing of it', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    const elsewhere = { formKey: '000900:Patch.esp', plugin: { name: 'Patch.esp', origin: 'PatchMod' } };
    client.setQueryAnswerOnce('getRecordHolders', [{ name: 'MyPatch.esp', origin: 'ModA' }]);
    client.setQueryAnswerOnce('getRecordHolders', [PATCH]);
    client.setCommandResult('getCopyChanges', {
      applied: [
        copyChanges(SOURCE, PATCH),
        copyChanges(elsewhere, PATCH),
        copyChanges(elsewhere, OTHER),
      ],
      refused: [{ item: { record: SOURCE, destination: OTHER }, reason: 'boom' }],
    });
    pick('Override', [PATCH, OTHER]);
    const { ask, reporter } = invoke(client);

    await copy(RECORD_NODE, [RECORD_NODE, carrying(elsewhere)]);

    expect(ask.asked).toEqual([]);
    expect(copyCalls(client)).toEqual([[[SOURCE, elsewhere], 'Override', [PATCH, OTHER], false]]);
    expect(reporter.landings).toEqual(['Made 2 copies.']);
    expect(reporter.reports.map((r) => r.message)).toEqual(['Could not make 1 of 3 copies.']);
  });

  it('never asks to replace a copy as new, which lands under a FormID of its own', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
    pick('New', [PATCH]);
    const { ask } = invoke(client);

    await copy(RECORD_NODE);

    expect(ask.asked).toEqual([]);
  });

  it('says where the copies landed, naming each refused item and why', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('getCopyChanges', {
      applied: [copyChanges(SOURCE, PATCH)],
      refused: [{ item: { record: SOURCE, destination: OTHER }, reason: 'Other.esp is not a compiled plugin' }],
    });
    pick('New', [PATCH, OTHER]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.landings).toEqual(['Copied 000801:MyPatch.esp into Patch.esp.']);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not make 1 of 2 copies.',
      detail: '"000801:MyPatch.esp in MyPatch.esp (ModA) into Other.esp (OtherMod)" (Other.esp is not a compiled plugin)',
    }]);
  });

  it('reports a refused call at error', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('getCopyChanges', { refused: true, message: 'Could not copy 1 record — boom' });
    pick('New', [PATCH]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not copy 1 record — boom', detail: undefined }]);
  });

  it('says why a destination lookup failed, and copies nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', { failed: 'refused', refusal: 'No load order has been received.' });
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(items.find((item) => item.mode === 'New')));
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not look up the plugins to copy into.',
      detail: 'No load order has been received.',
    }]);
    expect(copyCalls(client)).toEqual([]);
  });

  it('says why it could not check which destinations hold the records, and copies nothing', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setQueryFailure('getRecordHolders', { failed: 'refused', refusal: 'mEdit is stopped.' });
    pick('Override', [PATCH]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not check which plugins already hold a copy.',
      detail: 'mEdit is stopped.',
    }]);
    expect(copyCalls(client)).toEqual([]);
  });

  it('says so when no plugin can take the copy, and offers no pick of none', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'NonCompiledPlugin.esp', origin: 'ModB', isCompiledPlugin: false })]);
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(items.find((item) => item.mode === 'New')));
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.landings).toEqual(['No plugin can take the copy: Decompile and commit a mod to edit its plugins.']);
    expect(showQuickPick).toHaveBeenCalledOnce();
  });

  it('runs the copy inside the write, which ends when the call is answered', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    pick('New', [PATCH, OTHER]);
    const { writing } = invoke(client);
    client.setCommandHandler('getCopyChanges', () => {
      writing.push('copy');
      return Promise.resolve({ applied: [copyChanges(SOURCE, PATCH)], refused: [] });
    });

    await copy(RECORD_NODE);

    expect(writing).toEqual(['opens', 'copy', 'ends']);
  });

  it('opens no write when the pick is left with Esc', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    pick('New', undefined);
    const { writing } = invoke(client);

    await copy(RECORD_NODE);

    expect(writing).toEqual([]);
  });

  it('ends the write after mEdit refuses the call, and reports it', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('getCopyChanges', { refused: true, message: 'Could not copy 1 record — socket hang up' });
    pick('New', [PATCH]);
    const { writing, reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(writing).toEqual(['opens', 'ends']);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not copy 1 record — socket hang up', detail: undefined }]);
  });

  describe('the changes mEdit answers', () => {
    const answered = () => [copyChanges(SOURCE, PATCH), copyChanges(SECOND, PATCH), copyChanges(SOURCE, OTHER)];

    async function copyAnswered(applied: readonly ReturnType<typeof copyChanges>[], refused: ItemRefusal<CopyItem>[] = []) {
      const client = new InMemoryMEditClient();
      destinations(client);
      client.setCommandResult('getCopyChanges', { applied, refused });
      pick('New', [PATCH, OTHER]);
      const invoked = invoke(client);
      await copy(RECORD_NODE);
      return invoked;
    }

    it('makes them as one workspace edit, then refreshes Source Control once for each destination plugin', async () => {
      const applied = answered();
      const { source } = await copyAnswered(applied);

      expect(source.applyWorkspaceChanges.mock.calls).toEqual([[applied]]);
      expect(source.refreshSourceControlFor.mock.calls).toEqual([[PATCH], [OTHER]]);
    });

    it('runs the whole copy after the edits in flight settle', async () => {
      const client = new InMemoryMEditClient();
      destinations(client);
      client.setCommandResult('getCopyChanges', { applied: [], refused: [] });
      pick('New', [PATCH, OTHER]);
      const { source, writing } = invoke(client);
      const settle = editInFlight(source);

      const copying = copy(RECORD_NODE);
      await vi.waitFor(() => expect(writing).toEqual(['opens']));
      expect(asked(client, 'getCopyChanges')).toEqual([]);
      settle();
      await copying;

      expect(asked(client, 'getCopyChanges')).toHaveLength(1);
    });

    it('reports a workspace edit VS Code did not make as one that may have partly landed, lands none, refreshes Source Control, and counts the copies asked', async () => {
      const client = new InMemoryMEditClient();
      destinations(client);
      const refusal = { item: { record: SOURCE, destination: OTHER }, reason: 'Other.esp is not a compiled plugin' };
      client.setCommandResult('getCopyChanges', { applied: [copyChanges(SOURCE, PATCH)], refused: [refusal] });
      pick('New', [PATCH, OTHER]);
      const { reporter, source } = invoke(client);
      source.applyWorkspaceChanges.mockRejectedValue(new Error('VS Code did not apply the changes.'));

      await copy(RECORD_NODE);

      expect(reporter.reports[0]).toEqual(
        { severity: 'error', message: 'Could not copy the records.', detail: "VS Code did not apply the changes. VS Code stops at the first change it cannot make, so some changes may have landed." });
      expect(reporter.landings).toEqual([]);
      expect(reporter.reports.map((r) => r.message)).toEqual(['Could not copy the records.', 'Could not make 1 of 2 copies.']);
      expect(source.refreshSourceControlFor).toHaveBeenCalledWith(PATCH);
    });
  });
});
