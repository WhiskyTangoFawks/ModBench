import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, registerDeleteHereCommands, recordArgument,
} from '../recordLifecycleCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { RecordWrite } from '../../drivingLib/writingGesture';
import { ReferencedByHolderNode, REFERENCED_BY_VIEW } from '../ReferencedByTreeProvider';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

const RECORD_NODE = {
  kind: 'record', origin: 'ModA',
  record: { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', editorId: null },
};
const RECORD_IDENTITY = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };

function recordingWrite(): { write: RecordWrite; writing: string[]; viewsAskedFor: (string | undefined)[] } {
  const writing: string[] = [];
  const viewsAskedFor: (string | undefined)[] = [];
  return {
    writing, viewsAskedFor,
    write: async (command, invokedFrom) => {
      viewsAskedFor.push(invokedFrom);
      writing.push('opens');
      await command();
      writing.push('ends');
    },
  };
}

describe('recordArgument — structural, not node-typed', () => {
  it('reads a RecordNode-shaped row', () => {
    expect(recordArgument(RECORD_NODE)).toEqual({ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA', editorId: undefined });
  });

  it('reads a plain identity literal the same way', () => {
    expect(recordArgument(RECORD_IDENTITY)).toEqual({ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA', editorId: undefined });
  });

  it.each(['worldspace', 'cell', 'placed'])('reads a %s row that states its record\'s FormKey and EditorID beside its plugin', (kind) => {
    expect(recordArgument({ kind, formKey: '000802:MyPatch.esp', editorId: 'Here', plugin: 'MyPatch.esp', origin: 'ModA' }))
      .toEqual({ formKey: '000802:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA', editorId: 'Here' });
  });

  it('is undefined for neither shape', () => {
    expect(recordArgument({ nothing: true })).toBeUndefined();
  });
});

describe('registerRecordLifecycleCommands', () => {
  let viewSelection: readonly unknown[] = [];
  function invoke(client: InMemoryMEditClient, ...answers: readonly (string | undefined)[]) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    const { write, writing, viewsAskedFor } = recordingWrite();
    registerRecordLifecycleCommands(client, reporter, ask, () => viewSelection, write);
    return { reporter, ask, writing, viewsAskedFor };
  }

  describe('from the palette, handed no row, taking the Plugins selection', () => {
    afterEach(() => { viewSelection = []; });

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

  describe('a view\'s Delete key, which cannot name its view', () => {
    const PLUGINS_ROW = { kind: 'record', origin: 'ModA', record: { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', editorId: null } };
    const HOLDER_ROW = { formKey: '000900:Other.esp', plugin: 'Other.esp', origin: 'ModB', editorId: 'Held' };

    it('deletes the selection of the view it is bound in, not the view last selected in', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [], refused: [] });
      viewSelection = [HOLDER_ROW];
      invoke(client, 'Delete');
      registerDeleteHereCommands(new Map<string, () => readonly unknown[]>([
        ['modbench.pluginListTree', () => [PLUGINS_ROW]],
        ['modbench.referencedByTree', () => [HOLDER_ROW]],
      ]));

      await present(handlers.get('modbench.pluginListTree.deleteHere'), 'the Plugins delete key command')();

      expect(client.calls.filter(c => c.method === 'deleteRecords').map(c => c.args[0])).toEqual([
        [{ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' }],
      ]);
    });

    it('deletes a plugin copy in Referenced By as (plugin, origin) of that copy', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [], refused: [] });
      invoke(client, 'Delete');
      registerDeleteHereCommands(new Map([['modbench.referencedByTree', () => [HOLDER_ROW]]]));

      await present(handlers.get('modbench.referencedByTree.deleteHere'), 'the Referenced By delete key command')();

      expect(client.calls.filter(c => c.method === 'deleteRecords').map(c => c.args[0])).toEqual([
        [{ formKey: '000900:Other.esp', plugin: 'Other.esp', origin: 'ModB' }],
      ]);
    });

    it('does nothing with nothing selected, rather than fall back to another view', async () => {
      const client = new InMemoryMEditClient();
      viewSelection = [HOLDER_ROW];
      invoke(client, 'Delete');
      registerDeleteHereCommands(new Map([['modbench.pluginListTree', () => []]]));

      await present(handlers.get('modbench.pluginListTree.deleteHere'), 'the Plugins delete key command')();

      expect(client.calls.filter(c => c.method === 'deleteRecords')).toEqual([]);
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

    const COLUMN_HEADER = { webviewSection: 'recordHeader', ...FIRST, editable: true, preventDefaultContextMenuItems: true };

    it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY], ['the Editor\'s column header', COLUMN_HEADER]])(
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

    it('deletes nothing and says nothing when the confirmation is cancelled, rather than deleting whatever the dialog answered', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST, SECOND], refused: [] });
      const { reporter } = invoke(client, undefined);

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(deleteCalls(client)).toEqual([]);
      expect(reporter.reports).toEqual([]);
    });

    it('reports a partial answer once, naming the refused record and why', async () => {
      const client = new InMemoryMEditClient();
      const outcome = {
        landed: [FIRST, SECOND],
        refused: [{ item: UNTRACKED, reason: 'Other.esp is not tracked, so it is read-only.' }],
      };
      client.setCommandResult('deleteRecords', outcome);
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, UNTRACKED_NODE, SECOND_NODE]);

      expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not delete 1 of 3 records.', outcome }]);
      expect(reporter.reports).toEqual([{
        severity: 'error',
        message: 'Could not delete 1 of 3 records.',
        detail: '"000900:Other.esp in Other.esp (ModB)" (Other.esp is not tracked, so it is read-only.)',
      }]);
    });

    it('refuses a record whose argument states no origin, naming it, since a filename alone names no one plugin, and still deletes the rest', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST], refused: [] });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(RECORD_NODE, [RECORD_NODE, { formKey: '000700:Lost.esp', plugin: 'Lost.esp' }]);

      expect(deleteCalls(client)).toEqual([[[FIRST]]]);
      expect(reporter.reports).toEqual([{
        severity: 'error',
        message: 'Could not delete 1 of 2 records.',
        detail: '"000700:Lost.esp in Lost.esp" (it states no origin)',
      }]);
    });

    it('says nothing when every record landed', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [FIRST, SECOND], refused: [] });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
    });

    it('reports the ready-to-show message at error when the call itself fails', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { refused: true, message: 'Could not delete 2 records — boom' });
      const { reporter } = invoke(client, 'Delete');

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(reporter.reports).toEqual([
        { severity: 'error', message: 'Could not delete 2 records — boom', detail: undefined },
      ]);
    });

    it('runs the delete inside the write, which ends when the call is answered', async () => {
      const client = new InMemoryMEditClient();
      const { writing } = invoke(client, 'Delete');
      client.setCommandHandler('deleteRecords', () => {
        writing.push('delete');
        return Promise.resolve({ landed: [FIRST], refused: [{ item: SECOND, reason: 'no' }] });
      });

      await deleteRecords(SECOND_NODE, [RECORD_NODE, SECOND_NODE]);

      expect(writing).toEqual(['opens', 'delete', 'ends']);
    });

    it('runs under Referenced By\'s bar when the rows are Referenced By\'s, and under the default bar for a Plugins row', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { landed: [], refused: [] });
      const { viewsAskedFor } = invoke(client, 'Delete', 'Delete');
      const holder = new ReferencedByHolderNode('000001:A.esp', SECOND.formKey, 'SecondNpc', { name: 'MyPatch.esp', origin: 'ModA' }, []);

      await deleteRecords(holder);
      await deleteRecords(SECOND_NODE);

      expect(viewsAskedFor).toEqual([REFERENCED_BY_VIEW, undefined]);
    });

    it('opens no write when the question is declined', async () => {
      const client = new InMemoryMEditClient();
      const { writing } = invoke(client, undefined);

      await deleteRecords(SECOND_NODE);

      expect(writing).toEqual([]);
    });

    it('ends the write after mEdit refuses the call, and reports it', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('deleteRecords', { refused: true, message: 'Could not delete 1 record — socket hang up' });
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
  const SOURCE = { formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
  const SECOND_NODE = {
    kind: 'record', origin: 'ModA',
    record: { formKey: '000802:MyPatch.esp', plugin: 'MyPatch.esp', editorId: 'Second' },
  };
  const SECOND = { formKey: '000802:MyPatch.esp', plugin: 'MyPatch.esp', origin: 'ModA' };
  const PATCH = { name: 'Patch.esp', origin: 'PatchMod' };
  const OTHER = { name: 'Other.esp', origin: 'OtherMod' };
  const HEADER = { webviewSection: 'recordHeader', ...SOURCE, editable: true, preventDefaultContextMenuItems: true };

  let viewSelection: readonly unknown[] = [];
  afterEach(() => { viewSelection = []; });
  beforeEach(function dropUnansweredPicksSoTheyDoNotAnswerTheNextTest() { showQuickPick.mockReset(); });

  function invoke(client: InMemoryMEditClient, ...answers: readonly (string | undefined)[]) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    const { write, writing, viewsAskedFor } = recordingWrite();
    registerRecordCopyCommands(client, reporter, ask, () => viewSelection, write);
    return { reporter, ask, writing, viewsAskedFor };
  }

  const copy = (...args: unknown[]) =>
    present(handlers.get('modbench.record.copy'), "the handler registered for 'modbench.record.copy'")(...args);

  function destinations(client: InMemoryMEditClient) {
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: 'MyPatch.esp', origin: 'ModA', loadOrderIndex: 2, isTracked: true }),
      pluginMetadataFixture({ name: 'Patch.esp', origin: 'PatchMod', loadOrderIndex: 4, isTracked: true }),
      pluginMetadataFixture({ name: 'Other.esp', origin: 'OtherMod', loadOrderIndex: 6, isTracked: true }),
    ]);
  }

  function pick(mode: 'Override' | 'New' | undefined, picked?: readonly { name: string; origin: string }[]) {
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(items.find((item) => item.mode === mode)));
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(picked && items.filter((item) => picked.some((p) => p.name === item.plugin?.name))));
  }

  const copyCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'copyRecords').map((c) => c.args);

  it.each([['a RecordNode row', RECORD_NODE], ['a plain identity literal', RECORD_IDENTITY], ['the Editor\'s record header', HEADER]])(
    'copies the record %s names into every destination picked, in the mode picked', async (_what, arg) => {
      const client = new InMemoryMEditClient();
      destinations(client);
      client.setCommandResult('copyRecords', { landed: [], refused: [] });
      pick('New', [PATCH, OTHER]);
      invoke(client);

      await copy(arg);

      expect(copyCalls(client)).toEqual([[[SOURCE], 'New', [PATCH, OTHER], false]]);
    });

  it('refuses a record whose argument states no origin, naming it, and still copies the rest', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
    pick('New', [PATCH]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE, [RECORD_NODE, { formKey: '000700:Lost.esp', plugin: 'Lost.esp' }]);

    expect(copyCalls(client)).toEqual([[[SOURCE], 'New', [PATCH], false]]);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not copy 1 of 2 records.',
      detail: '"000700:Lost.esp in Lost.esp" (it states no origin)',
    }]);
  });

  it('takes the whole selection when the right-clicked row is one of several selected', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
    pick('New', [PATCH]);
    invoke(client);

    await copy(RECORD_NODE, [RECORD_NODE, SECOND_NODE]);

    expect(copyCalls(client)).toEqual([[[SOURCE, SECOND], 'New', [PATCH], false]]);
  });

  it('from the palette, takes the Plugins selection', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
    pick('New', [PATCH]);
    viewSelection = [RECORD_NODE, SECOND_NODE];
    invoke(client);

    await copy();

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
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
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
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
    pick('Override', [PATCH]);
    const { ask } = invoke(client);

    await copy(RECORD_NODE);

    expect(ask.asked).toEqual([]);
    expect(copyCalls(client)).toEqual([[[SOURCE], 'Override', [PATCH], false]]);
  });

  it('asks nothing of a record\'s own plugin picked for a mixed selection, which holds the record and no copy to replace, and says nothing of it', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    const elsewhere = { formKey: '000900:Patch.esp', plugin: 'Patch.esp', origin: 'PatchMod' };
    client.setQueryAnswerOnce('getRecordHolders', [{ name: 'MyPatch.esp', origin: 'ModA' }]);
    client.setQueryAnswerOnce('getRecordHolders', [PATCH]);
    client.setCommandResult('copyRecords', {
      landed: [
        { record: SOURCE, destination: PATCH },
        { record: elsewhere, destination: PATCH },
        { record: elsewhere, destination: OTHER },
      ],
      refused: [{ item: { record: SOURCE, destination: OTHER }, reason: 'boom' }],
    });
    pick('Override', [PATCH, OTHER]);
    const { ask, reporter } = invoke(client);

    await copy(RECORD_NODE, [RECORD_NODE, elsewhere]);

    expect(ask.asked).toEqual([]);
    expect(copyCalls(client)).toEqual([[[SOURCE, elsewhere], 'Override', [PATCH, OTHER], false]]);
    expect(reporter.landings).toEqual(['Made 2 copies.']);
    expect(reporter.reports.map((r) => r.message)).toEqual(['Could not make 1 of 3 copies.']);
  });

  it('never asks to replace a copy as new, which lands under a FormID of its own', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
    pick('New', [PATCH]);
    const { ask } = invoke(client);

    await copy(RECORD_NODE);

    expect(ask.asked).toEqual([]);
    expect(client.calls.some((c) => c.method === 'getRecordHolders')).toBe(false);
  });

  it('says where the copies landed, naming each refused item and why', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', {
      landed: [{ record: SOURCE, destination: PATCH }],
      refused: [{ item: { record: SOURCE, destination: OTHER }, reason: 'Other.esp is not tracked' }],
    });
    pick('New', [PATCH, OTHER]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.landings).toEqual(['Copied 000801:MyPatch.esp into Patch.esp.']);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not make 1 of 2 copies.',
      detail: '"000801:MyPatch.esp in MyPatch.esp (ModA) into Other.esp (OtherMod)" (Other.esp is not tracked)',
    }]);
  });

  it('reports a refused call at error', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', { refused: true, message: 'Could not copy 1 record — boom' });
    pick('New', [PATCH]);
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not copy 1 record — boom', detail: undefined }]);
  });

  it('says why a destination lookup failed, and copies nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', new Error('GET /plugins failed (503): No load order has been received.'));
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(items.find((item) => item.mode === 'New')));
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not look up the plugins to copy into.',
      detail: 'GET /plugins failed (503): No load order has been received.',
    }]);
    expect(copyCalls(client)).toEqual([]);
  });

  it('says why it could not check which destinations hold the records, and copies nothing', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setQueryFailure('getRecordHolders', new Error('mEdit is stopped.'));
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
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'Untracked.esp', origin: 'ModB', isTracked: false })]);
    showQuickPick.mockImplementationOnce((items) =>
      Promise.resolve(items.find((item) => item.mode === 'New')));
    const { reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(reporter.landings).toEqual(['No plugin can take the copy: Track a plugin to edit it.']);
    expect(showQuickPick).toHaveBeenCalledOnce();
  });

  it('runs the copy inside the write, which ends when the call is answered', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    pick('New', [PATCH, OTHER]);
    const { writing } = invoke(client);
    client.setCommandHandler('copyRecords', () => {
      writing.push('copy');
      return Promise.resolve({ landed: [{ record: SOURCE, destination: PATCH, newFormKey: '000900:Patch.esp' }], refused: [] });
    });

    await copy(RECORD_NODE);

    expect(writing).toEqual(['opens', 'copy', 'ends']);
  });

  it('runs under Referenced By\'s bar when the rows are Referenced By\'s', async () => {
    const client = new InMemoryMEditClient();
    destinations(client);
    client.setCommandResult('copyRecords', { landed: [], refused: [] });
    pick('New', [PATCH]);
    const { viewsAskedFor } = invoke(client);
    const holder = new ReferencedByHolderNode('000001:A.esp', SOURCE.formKey, undefined, { name: 'MyPatch.esp', origin: 'ModA' }, []);

    await copy(holder);

    expect(viewsAskedFor).toEqual([REFERENCED_BY_VIEW]);
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
    client.setCommandResult('copyRecords', { refused: true, message: 'Could not copy 1 record — socket hang up' });
    pick('New', [PATCH]);
    const { writing, reporter } = invoke(client);

    await copy(RECORD_NODE);

    expect(writing).toEqual(['opens', 'ends']);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not copy 1 record — socket hang up', detail: undefined }]);
  });
});
