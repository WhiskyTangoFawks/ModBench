import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

interface PickItem { label: string; description?: string }
type ShowQuickPick = (items: readonly PickItem[]) => Promise<unknown>;
interface InputBoxOptions { prompt?: string; placeHolder?: string; value?: string; validateInput?: (value: string) => string | undefined }
type ShowInputBox = (options: InputBoxOptions) => Promise<string | undefined>;

const { handlers, showQuickPick, showInputBox } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  showQuickPick: vi.fn<ShowQuickPick>(),
  showInputBox: vi.fn<ShowInputBox>(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(id, handler);
      return { dispose: () => {} };
    },
  },
  window: { showQuickPick, showInputBox },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
}));

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordSummaryFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { registerRecordCreateCommand } from '../createRecordCommand';
import type { RecordPlace } from '../createdRecordSelection';
import { PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { CellNode, RecordNode, RecordTypeNode, WorldspaceNode } from '../PluginTreeProvider';

const PLUGIN_ROW = new PluginNode({ name: 'MyPatch.esp', enabled: true }, 'ModA');
const EDITABLE = { tracked: true, editable: true };
const NPC_GROUP = new RecordTypeNode('MyPatch.esp', recordTypeCountFixture({ type: 'npc_', count: 3, displayName: 'Non-Player Character' }), 'ModA', EDITABLE);
const OTHER_GROUP = new RecordTypeNode('Other.esp', recordTypeCountFixture({ type: 'weap', displayName: 'Weapon' }), 'ModB', EDITABLE);
const RECORD_ROW = new RecordNode(recordSummaryFixture({ formKey: '000800:MyPatch.esp', plugin: 'MyPatch.esp' }), 'ModA', EDITABLE);
const QUEST_ROW = new RecordNode(recordSummaryFixture({ formKey: '000801:MyPatch.esp', plugin: 'MyPatch.esp', editorId: 'MQ101' }), 'ModA', EDITABLE, true);
const CELL_ROW = new CellNode('MyPatch.esp', {
  formKey: '000802:MyPatch.esp', editorId: 'MyCell', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false,
}, 'ModA', EDITABLE);
const WORLDSPACE_ROW = new WorldspaceNode('MyPatch.esp', { formKey: '000803:MyPatch.esp', hasChildren: false, hasParseFailure: false }, 'ModA', EDITABLE);
QUEST_ROW.id = 'MQ101';
CELL_ROW.id = 'MyCell';
WORLDSPACE_ROW.id = '000803:MyPatch.esp';
const QUEST_HOLDS = [
  { type: 'dlbr', displayName: 'Dialog Branch' }, { type: 'dial', displayName: 'Dialog Topic' }, { type: 'scen', displayName: 'Scene' },
];
const CREATABLE = [
  { type: 'acti', displayName: 'Activator' }, { type: 'npc_', displayName: 'Non-Player Character' },
];
const NEW_NPC = { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' };

function harness(viewSelection: readonly PluginsTreeNode[] = []) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getCreatableRecordTypes', CREATABLE);
  client.setQueryAnswer('getChildRecordTypes', QUEST_HOLDS);
  const steps: string[] = [];
  client.setCommandHandler('createRecord', (...args) => {
    const [plugin, recordType, into] = args;
    steps.push(`create ${plugin.name} ${plugin.origin} ${recordType}${into === undefined ? '' : ` ${JSON.stringify(into)}`}`);
    return Promise.resolve(NEW_NPC);
  });
  const reporter = recordingReporter();
  const writing: string[] = [];
  registerRecordCreateCommand({
    client, reporter,
    write: async (command) => {
      writing.push('opens');
      await command();
      writing.push('ends');
    },
    createdRecords: {
      watch: (plugin) => {
        steps.push(`watch ${plugin.name} ${plugin.origin}`);
        return {
          select: (place: RecordPlace<PluginsTreeNode>, formKey: string) => {
            steps.push(`select ${formKey} ${'container' in place ? `beneath ${place.container.id ?? ''}` : `in ${place.recordType}`}`);
          },
          forget: () => { steps.push('forget'); },
        };
      },
    },
  }, () => viewSelection);
  const create = present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'");
  return { client, reporter, steps, writing, create };
}

beforeEach(() => { showQuickPick.mockReset(); showInputBox.mockReset(); });

describe('modbench.record.create', () => {
  it('on a group, awaits the new record of its type, then creates it, asking nothing', async () => {
    const { steps, create } = harness([OTHER_GROUP]);

    await create(NPC_GROUP);

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(steps).toEqual(['watch MyPatch.esp ModA', 'create MyPatch.esp ModA npc_', 'select 000900:MyPatch.esp in npc_']);
  });

  it('on a plugin, picks the record type from the types the game can create, then creates one', async () => {
    const { steps, create } = harness();
    showQuickPick.mockImplementation((items) => Promise.resolve(items[0]));

    await create(PLUGIN_ROW);

    expect(showQuickPick.mock.calls[0]?.[0].map((item) => [item.label, item.description])).toEqual([
      ['Activator', 'acti'], ['Non-Player Character', 'npc_'],
    ]);
    expect(steps).toEqual(['watch MyPatch.esp ModA', 'create MyPatch.esp ModA acti', 'select 000900:MyPatch.esp in acti']);
  });

  it('from the palette, creates in the one selected plugin', async () => {
    const { steps, create } = harness([PLUGIN_ROW]);
    showQuickPick.mockImplementation((items) => Promise.resolve(items[1]));

    await create();

    expect(steps).toEqual(['watch MyPatch.esp ModA', 'create MyPatch.esp ModA npc_', 'select 000900:MyPatch.esp in npc_']);
  });

  it('creates nothing, awaits nothing and says nothing when the type pick is left with Esc', async () => {
    const { steps, reporter, create } = harness();
    showQuickPick.mockResolvedValue(undefined);

    await create(PLUGIN_ROW);

    expect(steps).toEqual([]);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('says why when mEdit cannot name the types, and creates nothing', async () => {
    const { client, steps, reporter, create } = harness();
    client.setQueryFailure('getCreatableRecordTypes', new Error('mEdit is not running'));

    await create(PLUGIN_ROW);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not look up the record types to create.', detail: 'mEdit is not running' },
    ]);
    expect(steps).toEqual([]);
  });

  it('does nothing on a record row that is no container, or with no row and no single plugin, group or container selected', async () => {
    const { steps, reporter, create } = harness([PLUGIN_ROW, NPC_GROUP]);
    showQuickPick.mockImplementation((items) => Promise.resolve(items[0]));

    await create(RECORD_ROW);
    await create();

    expect(steps).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('creates in the group\'s own plugin when another plugin shares its filename', async () => {
    const { steps, create } = harness();
    const overriding = new RecordTypeNode('MyPatch.esp', recordTypeCountFixture({ type: 'npc_', count: 3, displayName: 'Non-Player Character' }), 'ModB', EDITABLE);

    await create(overriding);

    expect(steps).toEqual(['watch MyPatch.esp ModB', 'create MyPatch.esp ModB npc_', 'select 000900:MyPatch.esp in npc_']);
  });

  it('lands the new record\'s FormKey', async () => {
    const { reporter, create } = harness();

    await create(NPC_GROUP);

    expect(reporter.landings).toEqual(['Created 000900:MyPatch.esp.']);
  });

  it('reports a refusal as mEdit words it, and stops awaiting a record it did not write', async () => {
    const { client, steps, reporter, create } = harness();
    const message = 'MyPatch.esp has exhausted its ESL FormKey space. Clear the light flag in the header, or change a record\'s FormID.';
    client.setCommandHandler('createRecord', () => Promise.resolve({ refused: true, message }));

    await create(NPC_GROUP);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: undefined }]);
    expect(reporter.landings).toEqual([]);
    expect(steps).toEqual(['watch MyPatch.esp ModA', 'forget']);
  });
});

describe('modbench.record.create on a container', () => {
  const pickItems = () => showQuickPick.mock.calls[0]?.[0].map((item) => [item.label, item.description]);
  const prompt = () => present(showInputBox.mock.calls[0]?.[0], 'the grid position prompt');

  it('picks from the types mEdit answers the container can hold, then creates the picked type in it', async () => {
    const { client, steps, create } = harness();
    showQuickPick.mockImplementation((items) => Promise.resolve(items[1]));

    await create(QUEST_ROW);

    expect(client.calls.filter((c) => c.method === 'getChildRecordTypes').map((c) => c.args))
      .toEqual([[{ name: 'MyPatch.esp', origin: 'ModA' }, '000801:MyPatch.esp']]);
    expect(pickItems()).toEqual([['Dialog Branch', 'dlbr'], ['Dialog Topic', 'dial'], ['Scene', 'scen']]);
    expect(steps).toEqual([
      'watch MyPatch.esp ModA', 'create MyPatch.esp ModA dial {"container":"000801:MyPatch.esp"}', 'select 000900:MyPatch.esp beneath MQ101',
    ]);
  });

  it('creates the one type a container can hold, asking nothing', async () => {
    const { client, steps, create } = harness();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'refr', displayName: 'Placed Object' }]);

    await create(CELL_ROW);

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInputBox).not.toHaveBeenCalled();
    expect(steps).toEqual([
      'watch MyPatch.esp ModA', 'create MyPatch.esp ModA refr {"container":"000802:MyPatch.esp"}', 'select 000900:MyPatch.esp beneath MyCell',
    ]);
  });

  it('on a worldspace, prompts for the new cell\'s grid position as x, y, and creates the cell at it', async () => {
    const { client, steps, create } = harness();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);
    showInputBox.mockResolvedValue(' -3 ,12 ');

    await create(WORLDSPACE_ROW);

    expect(showQuickPick).not.toHaveBeenCalled();
    expect([prompt().placeHolder, prompt().value]).toEqual(['x, y', undefined]);
    expect(steps).toEqual([
      'watch MyPatch.esp ModA',
      'create MyPatch.esp ModA cell {"container":"000803:MyPatch.esp","position":{"x":-3,"y":12}}',
      'select 000900:MyPatch.esp beneath 000803:MyPatch.esp',
    ]);
  });

  it('on a worldspace, prompts for no grid position for a type that is no cell', async () => {
    const { client, steps, create } = harness();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'road', displayName: 'Road' }]);

    await create(WORLDSPACE_ROW);

    expect(showInputBox).not.toHaveBeenCalled();
    expect(steps).toContain('create MyPatch.esp ModA road {"container":"000803:MyPatch.esp"}');
  });

  it('the grid position prompt refuses anything but two whole numbers', async () => {
    const { client, create } = harness();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);
    showInputBox.mockResolvedValue(undefined);
    await create(WORLDSPACE_ROW);
    const validate = present(prompt().validateInput, 'the prompt\'s validation');

    const refused = ['', '3', '3,', 'a, b', '1.5, 2', '1, 2, 3', '1 2', '0x1, 2'].filter((value) => validate(value) !== undefined);
    const accepted = ['0, 0', '-3, 12', '  7,-8  '].filter((value) => validate(value) === undefined);

    expect(refused).toEqual(['', '3', '3,', 'a, b', '1.5, 2', '1, 2, 3', '1 2', '0x1, 2']);
    expect(accepted).toEqual(['0, 0', '-3, 12', '  7,-8  ']);
    expect(validate('a, b')).toBe('Two whole numbers, as x, y.');
  });

  it('creates nothing, watches nothing and says nothing when the type pick is left with Esc', async () => {
    const { steps, reporter, create } = harness();
    showQuickPick.mockResolvedValue(undefined);

    await create(QUEST_ROW);

    expect(steps).toEqual([]);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('creates nothing, watches nothing and says nothing when the grid position prompt is left with Esc', async () => {
    const { client, steps, reporter, create } = harness();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);
    showInputBox.mockResolvedValue(undefined);

    await create(WORLDSPACE_ROW);

    expect(steps).toEqual([]);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('says a container that can hold nothing, as a deleted one, holds no new record, and creates nothing', async () => {
    const { client, steps, reporter, create } = harness();
    client.setQueryAnswer('getChildRecordTypes', []);

    await create(QUEST_ROW);

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([{ severity: 'error', message: '"MQ101" can hold no new record.', detail: undefined }]);
    expect(steps).toEqual([]);
  });

  it('says why when mEdit cannot name the types the container holds, and creates nothing', async () => {
    const { client, steps, reporter, create } = harness();
    client.setQueryFailure('getChildRecordTypes', new Error('mEdit is not running'));

    await create(QUEST_ROW);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not look up the record types to create.', detail: 'mEdit is not running' },
    ]);
    expect(steps).toEqual([]);
  });

  it('from the palette, creates in the one selected container', async () => {
    const { client, steps, create } = harness([CELL_ROW]);
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'refr', displayName: 'Placed Object' }]);

    await create();

    expect(steps).toContain('create MyPatch.esp ModA refr {"container":"000802:MyPatch.esp"}');
  });

  it('asks for neither Option a caller gives', async () => {
    const { steps, create } = harness();

    await create(WORLDSPACE_ROW, undefined, { recordType: 'cell', position: { x: 4, y: -5 } });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInputBox).not.toHaveBeenCalled();
    expect(steps).toContain('create MyPatch.esp ModA cell {"container":"000803:MyPatch.esp","position":{"x":4,"y":-5}}');
  });
});

describe('modbench.record.create ends when the write does', () => {
  it('runs the create inside the write, and asks nothing of it before the type is picked', async () => {
    const { client, writing, create } = harness();
    showQuickPick.mockImplementation((items) => { writing.push('picked'); return Promise.resolve(items[1]); });
    client.setCommandHandler('createRecord', () => { writing.push('create'); return Promise.resolve(NEW_NPC); });

    await create(PLUGIN_ROW);

    expect(writing).toEqual(['picked', 'opens', 'create', 'ends']);
  });

  it('settles the watch when the create throws', async () => {
    const { client, steps, create } = harness();
    client.setCommandHandler('createRecord', () => Promise.reject(new Error('connection reset')));

    await expect(create(NPC_GROUP)).rejects.toThrow('connection reset');

    expect(steps).toEqual(['watch MyPatch.esp ModA', 'forget']);
  });

  it('ends the write after mEdit refuses the create', async () => {
    const { client, writing, create } = harness();
    client.setCommandHandler('createRecord', () => Promise.resolve({ refused: true, message: 'no answer' }));

    await create(NPC_GROUP);

    expect(writing).toEqual(['opens', 'ends']);
  });
});
