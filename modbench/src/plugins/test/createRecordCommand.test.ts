import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, TreeItem } from './vscodeHost';
import { pluginsIndexedOver } from './pluginsOver';
import { recordSummaryFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import type { SourceEditing } from '../../textDocuments/sourceEditing';
import { settled } from '../../test/eventually';
import { present } from '../../ports/present';

const MY_PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
const NEW = '000900:MyPatch.esp';
const OTHER = '000800:MyPatch.esp';
const QUEST_HOLDS = [
  { type: 'dlbr', displayName: 'Dialog Branch' }, { type: 'dial', displayName: 'Dialog Topic' }, { type: 'scen', displayName: 'Scene' },
];
const CREATABLE = [{ type: 'acti', displayName: 'Activator' }, { type: 'npc_', displayName: 'Non-Player Character' }];
const NEW_NPC = { formKey: NEW, moves: [], deletions: [], documents: [{ path: '/source/ModA/plugin-source/MyPatch.esp/Npcs/000900_MyPatch.esp.json', text: '{}' }] };
const OPEN_NEW = ['modbench.record.open', { argument: { kind: 'record', formKey: NEW, plugin: MY_PATCH } }];
const NEW_RECORD = recordSummaryFixture({ formKey: NEW, plugin: 'MyPatch.esp', editorId: 'NewNpc' });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const rowsChanged = (keys: string[], origin = 'ModA') => [{ plugin: { name: 'MyPatch.esp', origin }, keys }];
const pluginChanged = (origin = 'ModA') => [{ plugin: { name: 'MyPatch.esp', origin } }];

async function creating({ shown = [NEW_RECORD] } = {}) {
  const applyWorkspaceChanges = vi.fn<SourceEditing['applyWorkspaceChanges']>(() => Promise.resolve());
  const refreshSourceControlFor = vi.fn();
  const made = await pluginsIndexedOver([MY_PATCH, { name: 'MyPatch.esp', origin: 'ModB' }], {
    sourceEditing: { applyWorkspaceChanges, oneAtATime: (job) => job(), refreshSourceControlFor },
  });
  const { client, rows, row } = made;
  client.setQueryAnswer('getCreatableRecordTypes', CREATABLE);
  client.setQueryAnswer('getChildRecordTypes', QUEST_HOLDS);
  client.setCommandResult('getCreateChanges', NEW_NPC);
  client.setQueryAnswer('getRecordTypes', [
    recordTypeCountFixture({ type: 'npc_', count: 3, displayName: 'Non-Player Character' }), recordTypeCountFixture({ type: 'qust', count: 1, displayName: 'Quest' }),
    recordTypeCountFixture({ type: 'wrld', count: 1, displayName: 'Worldspace' }),
  ]);
  client.setQueryAnswer('getRecords', { items: [
    recordSummaryFixture({ formKey: OTHER, plugin: 'MyPatch.esp', editorId: 'MQ101' }), ...shown,
  ], total: 1 + shown.length });
  client.setQueryAnswer('getContainerChildren', shown.map((record) => ({ ...record, recordType: 'dial', hasContainerChildren: false, isContainer: false })));
  client.setQueryAnswer('getWorldspaces', [{ formKey: '000803:MyPatch.esp', editorId: 'World', hasParseFailure: false, workingTreeState: 'None', hasChildren: true }]);
  client.setQueryAnswer('getWorldspaceBlocks', { blocks: [], topCells: [{
    formKey: '000802:MyPatch.esp', editorId: 'MyCell', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: true, fullName: null,
    hasParseFailure: false, workingTreeState: 'None',
  }] });
  client.setQueryAnswer('getCellChildRecords', { persistent: [], temporary: [] });
  const sole = async (parent: unknown) => present((await rows(parent))[0], 'a child row');
  const [npcs, quests, worlds] = await rows(row('MyPatch.esp', 'ModA'));
  const [record] = await rows(npcs);
  const [quest] = await rows(quests);
  const worldspace = await sole(worlds);
  const cell = await sole(worldspace);
  const [otherNpcs] = await rows(row('MyPatch.esp', 'ModB'));
  client.calls.length = 0;
  const view = made.view();
  return {
    client, applyWorkspaceChanges, refreshSourceControlFor, reporter: made.reporter('record.create'),
    rows: { plugin: row('MyPatch.esp', 'ModA'), npcs, record, quest, worldspace, cell, otherNpcs },
    run: (...args: unknown[]) => host.run('modbench.record.create', ...args),
    select: (...selected: unknown[]) => { view.selectRows(selected); },
    created: () => client.calls.filter(({ method }) => method === 'getCreateChanges').map(({ args }) => args),
    revealed: () => view.reveals,
    opened: () => host.executed.filter(([id]) => id === 'modbench.record.open'),
    pick: (index: number) => { host.picks((labels) => labels[index]); },
    pickItems: () => host.quickPicks.map(({ items }) => items),
  };
}

const SELECTED = { select: true, focus: true };

describe('modbench.record.create', () => {
  it('on a group, creates the new record of its type asking nothing, then selects its row once a change to its plugin names it, and opens it as a click does', async () => {
    const { client, run, select, rows, created, revealed, opened } = await creating();
    select(rows.otherNpcs);

    await run(rows.npcs);
    client.change(rowsChanged([NEW]));
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });

    expect(host.quickPicks).toEqual([]);
    expect(created()).toEqual([[MY_PATCH, 'npc_', undefined]]);
    expect(revealed()).toEqual([{ label: 'NewNpc', options: SELECTED }]);
  });

  it('on a plugin, picks the record type from the types the game can create, then creates one', async () => {
    const { run, rows, created, pick, pickItems } = await creating();
    pick(0);

    await run(rows.plugin);

    expect(pickItems()).toEqual([['Activator', 'Non-Player Character']]);
    expect(created()).toEqual([[MY_PATCH, 'acti', undefined]]);
  });

  it('from the palette, creates in the one selected plugin', async () => {
    const { run, select, rows, created, pick } = await creating();
    select(rows.plugin);
    pick(1);

    await run();

    expect(created()).toEqual([[MY_PATCH, 'npc_', undefined]]);
  });

  it.each([
    ['a plugin', 'plugin'],
    ['a container', 'quest'],
  ] as const)('creates nothing and says nothing when the type pick on %s is left with Esc', async (_row, which) => {
    const { client, run, rows, created, reporter } = await creating();

    await run(rows[which]);
    client.change(rowsChanged([NEW]));
    await settle();

    expect([created(), host.executed]).toEqual([[], []]);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it.each([
    ['a plugin', 'plugin', 'getCreatableRecordTypes'],
    ['a container', 'quest', 'getChildRecordTypes'],
  ] as const)('says why when mEdit cannot name the types %s holds, and creates nothing', async (_row, which, query) => {
    const { client, run, rows, created, reporter } = await creating();
    client.setQueryFailure(query, { failed: 'refused', refusal: 'mEdit is not running' });

    await run(rows[which]);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not look up the record types to create.', detail: 'mEdit is not running' }]);
    expect(created()).toEqual([]);
  });

  it.each([
    ['on a record row that is no container', ['record'] as const],
    ['with no row and no single plugin, group or container selected', [] as const],
  ])('does nothing %s', async (_case, clicked) => {
    const { run, select, rows, created, reporter, pick } = await creating();
    select(rows.plugin, rows.npcs);
    pick(0);

    await run(...clicked.map((which) => rows[which]));

    expect(created()).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('creates in the group\'s own plugin when another plugin shares its filename', async () => {
    const { run, rows, created } = await creating();

    await run(rows.otherNpcs);

    expect(created()).toEqual([[{ name: 'MyPatch.esp', origin: 'ModB' }, 'npc_', undefined]]);
  });

  it('applies the changes mEdit answers as one workspace edit, refreshes Source Control, under the Plugins bar, and lands the new record\'s FormKey', async () => {
    const { run, rows, applyWorkspaceChanges, refreshSourceControlFor, reporter } = await creating();

    await run(rows.npcs);

    expect(applyWorkspaceChanges.mock.calls).toEqual([[[NEW_NPC]]]);
    expect(refreshSourceControlFor.mock.calls).toEqual([[MY_PATCH]]);
    expect(host.progress).toEqual(['opens on modbench.pluginListTree', 'closes']);
    expect(reporter.landings).toEqual([`Created ${NEW}.`]);
  });

  it('reports a refusal as mEdit words it, and stops awaiting a record it did not write', async () => {
    const { client, run, rows, reporter } = await creating();
    const message = 'MyPatch.esp has no FormKey free after the highest of its own records, up to 0xFFF, the last a light plugin can address. Clear the light flag to draw above it.';
    client.setCommandResult('getCreateChanges', { refused: true, message });

    await run(rows.npcs);
    client.change(rowsChanged([NEW]));
    await settle();

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: undefined }]);
    expect(reporter.landings).toEqual([]);
    expect(host.executed).toEqual([]);
    expect(host.progress).toEqual(['opens on modbench.pluginListTree', 'closes']);
  });

  it('says the record could not be created when VS Code does not apply the change, and selects nothing', async () => {
    const { client, run, rows, applyWorkspaceChanges, reporter } = await creating();
    applyWorkspaceChanges.mockRejectedValue(new Error('VS Code did not apply the changes.'));

    await run(rows.npcs);
    client.change(rowsChanged([NEW]));
    await settle();

    expect(reporter.reports).toMatchObject([{ severity: 'error', message: 'Could not create the Non-Player Character record.' }]);
    expect([reporter.landings, host.executed]).toEqual([[], []]);
  });

  it('stops awaiting the record when the create throws', async () => {
    const { client, run, rows } = await creating();
    client.setCommandHandler('getCreateChanges', () => Promise.reject(new Error('connection reset')));

    await expect(run(rows.npcs)).rejects.toThrow('connection reset');
    client.change(rowsChanged([NEW]));
    await settle();

    expect(host.executed).toEqual([]);
  });

  it('asks nothing of mEdit\'s create before the type is picked', async () => {
    const { client, run, rows } = await creating();
    const order: string[] = [];
    host.picks((labels) => { order.push('picked'); return labels[1]; });
    client.setCommandHandler('getCreateChanges', () => { order.push('create'); return Promise.resolve(NEW_NPC); });

    await run(rows.plugin);

    expect(order).toEqual(['picked', 'create']);
  });
});

describe('modbench.record.create selects the new record once its plugin\'s change names it', () => {
  it.each([
    ['a change naming the record', rowsChanged([NEW])],
    ['a re-derived plugin', pluginChanged()],
  ])('selects at once when %s came before mEdit answered the create', async (_case, change) => {
    const { client, run, rows, revealed, opened } = await creating();
    client.setCommandHandler('getCreateChanges', () => { client.change(change); return Promise.resolve(NEW_NPC); });

    await run(rows.npcs);
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });

    expect(revealed()).toEqual([{ label: 'NewNpc', options: SELECTED }]);
  });

  it('waits past a change before mEdit answered the create that does not name the record', async () => {
    const { client, run, rows, opened } = await creating();
    client.setCommandHandler('getCreateChanges', () => { client.change(rowsChanged([OTHER])); return Promise.resolve(NEW_NPC); });

    await run(rows.npcs);
    await settle();
    expect(opened()).toEqual([]);

    client.change(rowsChanged([NEW]));
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });
  });

  it.each([
    ['a change naming the record in a plugin of the same name from another origin', rowsChanged([NEW], 'ModB')],
    ['a change that does not name the new record', rowsChanged([OTHER])],
    ['a re-derived plugin of the same name from another origin', pluginChanged('ModB')],
  ])('waits past %s', async (_case, change) => {
    const { client, run, rows, opened } = await creating();

    await run(rows.npcs);
    client.change(change);
    await settle();
    expect(opened()).toEqual([]);

    client.change(rowsChanged([NEW]));
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });
  });

  it('selects the new record\'s row beneath the container it landed in, once mEdit re-derives its whole plugin', async () => {
    const { client, run, rows, revealed, opened, pick } = await creating();
    pick(1);

    await run(rows.quest);
    client.change(pluginChanged());
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });

    expect(revealed()).toEqual([{ label: 'NewNpc', options: SELECTED }]);
  });

  it('opens a new record no row shows, as when the record filter hides it, selecting nothing, and once, however often a change names it again', async () => {
    const { client, run, rows, revealed, opened } = await creating({ shown: [] });

    await run(rows.npcs);
    client.change(pluginChanged());
    client.change(rowsChanged([NEW]));
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });
    client.change(rowsChanged([NEW]));
    client.change(pluginChanged());
    await settle();

    expect(revealed()).toEqual([]);
    expect(opened()).toEqual([OPEN_NEW]);
  });

  it('waits only for the latest create', async () => {
    const { client, run, rows, opened } = await creating();
    const later = { ...NEW_NPC, formKey: OTHER };
    let answerFirst = (): void => undefined;
    const answers = [new Promise<typeof NEW_NPC>((resolve) => { answerFirst = () => { resolve(NEW_NPC); }; }), Promise.resolve(later)];
    client.setCommandHandler('getCreateChanges', () => present(answers.shift(), 'an answer to the create'));
    const first = run(rows.npcs);
    await settle();
    const second = run(rows.npcs);
    await settle();
    answerFirst();
    await Promise.all([first, second]);
    client.change(rowsChanged([NEW]));
    await settle();
    expect(opened()).toEqual([]);

    client.change(rowsChanged([OTHER]));
    await settled(() => { expect(opened()).toEqual([['modbench.record.open', { argument: { kind: 'record', formKey: OTHER, plugin: MY_PATCH } }]]); });
  });
});

describe('modbench.record.create on a container', () => {
  const prompt = () => present(host.inputsAsked[0], 'the grid position prompt');

  it('picks from the types mEdit answers the container can hold, then creates the picked type in it', async () => {
    const { client, run, rows, created, pick, pickItems } = await creating();
    pick(1);

    await run(rows.quest);

    expect(client.calls.filter((c) => c.method === 'getChildRecordTypes').map((c) => c.args)).toEqual([[MY_PATCH, OTHER]]);
    expect(pickItems()).toEqual([['Dialog Branch', 'Dialog Topic', 'Scene']]);
    expect(created()).toEqual([[MY_PATCH, 'dial', { container: OTHER }]]);
  });

  it('creates the one type a container can hold, asking nothing', async () => {
    const { client, run, rows, created } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'refr', displayName: 'Placed Object' }]);

    await run(rows.cell);

    expect([host.quickPicks, host.inputsAsked]).toEqual([[], []]);
    expect(created()).toEqual([[MY_PATCH, 'refr', { container: '000802:MyPatch.esp' }]]);
  });

  it('on a worldspace, prompts for the new cell\'s grid position as x, y, and creates the cell at it', async () => {
    const { client, run, rows, created } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);
    host.types(() => ' -3 ,12 ');

    await run(rows.worldspace);

    expect(host.quickPicks).toEqual([]);
    expect([prompt().placeHolder, prompt().value]).toEqual(['x, y', undefined]);
    expect(created()).toEqual([[MY_PATCH, 'cell', { container: '000803:MyPatch.esp', position: { x: -3, y: 12 } }]]);
  });

  it('on a worldspace, prompts for no grid position for a type that is no cell', async () => {
    const { client, run, rows, created } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'road', displayName: 'Road' }]);

    await run(rows.worldspace);

    expect(host.inputsAsked).toEqual([]);
    expect(created()).toEqual([[MY_PATCH, 'road', { container: '000803:MyPatch.esp' }]]);
  });

  const NOT_A_GRID_POSITION = 'Two whole numbers, as x, y.';

  it.each<[string, string | undefined]>([
    ['', NOT_A_GRID_POSITION],
    ['3', NOT_A_GRID_POSITION],
    ['3,', NOT_A_GRID_POSITION],
    ['a, b', NOT_A_GRID_POSITION],
    ['1.5, 2', NOT_A_GRID_POSITION],
    ['1, 2, 3', NOT_A_GRID_POSITION],
    ['1 2', NOT_A_GRID_POSITION],
    ['0x1, 2', NOT_A_GRID_POSITION],
    ['0, 0', undefined],
    ['-3, 12', undefined],
    ['  7,-8  ', undefined],
  ])('the grid position prompt answers "%s" with %s', async (input, refusal) => {
    const { client, run, rows } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);

    await run(rows.worldspace);

    expect(prompt().validateInput?.(input)).toBe(refusal);
  });

  it('creates nothing and says nothing when the grid position prompt is left with Esc', async () => {
    const { client, run, rows, created, reporter } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);

    await run(rows.worldspace);

    expect(created()).toEqual([]);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('says a container that can hold nothing, as a deleted one, holds no new record, and creates nothing', async () => {
    const { client, run, rows, created, reporter } = await creating();
    client.setQueryAnswer('getChildRecordTypes', []);

    await run(rows.quest);

    expect(host.quickPicks).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: '"MQ101" can hold no new record.', detail: undefined }]);
    expect(created()).toEqual([]);
  });

  it('from the palette, creates in the one selected container', async () => {
    const { client, run, select, rows, created } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'refr', displayName: 'Placed Object' }]);
    select(rows.cell);

    await run();

    expect(created()).toEqual([[MY_PATCH, 'refr', { container: '000802:MyPatch.esp' }]]);
  });

  it('asks for neither Option a caller gives', async () => {
    const { run, rows, created } = await creating();

    await run(rows.worldspace, undefined, { recordType: 'cell', position: { x: 4, y: -5 } });

    expect([host.quickPicks, host.inputsAsked]).toEqual([[], []]);
    expect(created()).toEqual([[MY_PATCH, 'cell', { container: '000803:MyPatch.esp', position: { x: 4, y: -5 } }]]);
  });
});

describe('modbench.record.create on a row that is no Plugins row but carries a record Argument', () => {
  const referencedCopy = (formKey: string) => Object.assign(new TreeItem('MyPatch.esp'), { argument: { kind: 'record', formKey, plugin: MY_PATCH } });

  it('creates beneath the record in its plugin\'s copy, picking from the types that record can hold, and opens it without selecting a row', async () => {
    const { client, run, created, revealed, opened, pick, pickItems } = await creating();
    pick(0);

    await run(referencedCopy(OTHER));
    client.change(rowsChanged([NEW]));
    await settled(() => { expect(opened()).toEqual([OPEN_NEW]); });

    expect(pickItems()).toEqual([['Dialog Branch', 'Dialog Topic', 'Scene']]);
    expect(created()).toEqual([[MY_PATCH, 'dlbr', { container: OTHER }]]);
    expect(revealed()).toEqual([]);
  });

  it('asks for a grid position when the record can hold a cell', async () => {
    const { client, run, created } = await creating();
    client.setQueryAnswer('getChildRecordTypes', [{ type: 'cell', displayName: 'Cell' }]);
    host.types(() => '1, 2');

    await run(referencedCopy('000803:MyPatch.esp'));

    expect(created()).toEqual([[MY_PATCH, 'cell', { container: '000803:MyPatch.esp', position: { x: 1, y: 2 } }]]);
  });

  it('creates nothing for a row that names no plugin', async () => {
    const { run, created } = await creating();

    await run(Object.assign(new TreeItem('Referrer'), { argument: { kind: 'record', formKey: OTHER } }));

    expect(created()).toEqual([]);
  });
});
