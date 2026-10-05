import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

interface PickItem { label: string; description?: string }
type ShowQuickPick = (items: readonly PickItem[]) => Promise<unknown>;

const { handlers, showQuickPick } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  showQuickPick: vi.fn<ShowQuickPick>(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(id, handler);
      return { dispose: () => {} };
    },
  },
  window: { showQuickPick },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  Uri: { from: uriFrom },
}));

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordSummaryFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { registerRecordCreateCommand } from '../createRecordCommand';
import type { RecordGroup } from '../createdRecordSelection';
import { PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { RecordNode, RecordTypeNode } from '../PluginTreeProvider';

const PLUGIN_ROW = new PluginNode({ name: 'MyPatch.esp', enabled: true }, 'ModA');
const EDITABLE = { tracked: true, editable: true };
const NPC_GROUP = new RecordTypeNode('MyPatch.esp', recordTypeCountFixture({ type: 'npc_', count: 3, displayName: 'Non-Player Character' }), 'ModA', EDITABLE);
const OTHER_GROUP = new RecordTypeNode('Other.esp', recordTypeCountFixture({ type: 'weap', displayName: 'Weapon' }), 'ModB', EDITABLE);
const RECORD_ROW = new RecordNode(recordSummaryFixture({ formKey: '000800:MyPatch.esp', plugin: 'MyPatch.esp' }), 'ModA');
const CREATABLE = [
  { type: 'acti', displayName: 'Activator' }, { type: 'npc_', displayName: 'Non-Player Character' },
];
const NEW_NPC = { applied: true, formKey: '000900:MyPatch.esp', recordType: 'npc_' };

function harness(viewSelection: readonly PluginsTreeNode[] = []) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getCreatableRecordTypes', CREATABLE);
  const steps: string[] = [];
  client.setCommandHandler('createRecord', (...args) => {
    const [plugin, recordType] = args;
    steps.push(`create ${plugin.name} ${plugin.origin} ${recordType}`);
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
      selectWhenListed: (group: RecordGroup) => {
        steps.push(`await ${group.plugin.name} ${group.plugin.origin} ${group.recordType}`);
        return Promise.resolve(() => { steps.push('forget'); });
      },
    },
  }, () => viewSelection);
  const create = present(handlers.get('modbench.record.create'), "the handler registered for 'modbench.record.create'");
  return { client, reporter, steps, writing, create };
}

beforeEach(() => { showQuickPick.mockReset(); });

describe('modbench.record.create', () => {
  it('on a group, awaits the new record of its type, then creates it, asking nothing', async () => {
    const { steps, create } = harness([OTHER_GROUP]);

    await create(NPC_GROUP);

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(steps).toEqual(['await MyPatch.esp ModA npc_', 'create MyPatch.esp ModA npc_']);
  });

  it('on a plugin, picks the record type from the types the game can create, then creates one', async () => {
    const { steps, create } = harness();
    showQuickPick.mockImplementation((items) => Promise.resolve(items[0]));

    await create(PLUGIN_ROW);

    expect(showQuickPick.mock.calls[0]?.[0].map((item) => [item.label, item.description])).toEqual([
      ['Activator', 'acti'], ['Non-Player Character', 'npc_'],
    ]);
    expect(steps).toEqual(['await MyPatch.esp ModA acti', 'create MyPatch.esp ModA acti']);
  });

  it('from the palette, creates in the one selected plugin', async () => {
    const { steps, create } = harness([PLUGIN_ROW]);
    showQuickPick.mockImplementation((items) => Promise.resolve(items[1]));

    await create();

    expect(steps).toEqual(['await MyPatch.esp ModA npc_', 'create MyPatch.esp ModA npc_']);
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

  it('does nothing on a record row, or with no row and no single plugin or group selected', async () => {
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

    expect(steps).toEqual(['await MyPatch.esp ModB npc_', 'create MyPatch.esp ModB npc_']);
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
    expect(steps).toEqual(['await MyPatch.esp ModA npc_', 'forget']);
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

  it('ends the write after mEdit refuses the create', async () => {
    const { client, writing, create } = harness();
    client.setCommandHandler('createRecord', () => Promise.resolve({ refused: true, message: 'no answer' }));

    await create(NPC_GROUP);

    expect(writing).toEqual(['opens', 'ends']);
  });
});
