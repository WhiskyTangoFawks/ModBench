import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandHandlers, editorVscode, type FakePanel } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { holdsLoadOrder } from '../../client/test/says';
import { comparisonOf } from '../../test/comparison';
import { settled } from '../../test/eventually';
import { WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import { editAnswered, editorOver, forgetEditor } from './editorHarness';

const [OLD, NEW, ELSEWHERE] = ['000800:A.esp', '000900:A.esp', '000801:A.esp'];
const MOD = { name: 'A.esp', origin: 'ModA' };
const EDITED = { formKey: OLD, plugin: MOD.name, origin: MOD.origin };
const LEVEL = { op: 'set', path: [{ kind: 'member', name: 'Level' }], value: 1 };

const rowsChanged = (keys: string[]) => [{ plugin: MOD, keys }];
const PLUGIN_CHANGED = [{ plugin: MOD }];

const settles = (client: InMemoryMEditClient) => {
  holdsLoadOrder(client, { version: (client.recordIndexProgress?.version ?? 0) + 1 });
};

const loadsOf = (panel: FakePanel) => panel.webview.postMessage.mock.calls.map(([m]: unknown[]) => m)
  .filter((message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'loadRecord');

const applied = (newFormKey?: string) => editAnswered({ newFormKey, plugins: [MOD] });

beforeEach(forgetEditor);

function tabsOver() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getEditChanges', applied());
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/ModB/plugin-source/Other.esp/Npc.json' });
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...MOD, inLoadOrder: true })]);
  const { open, askedFromThePalette } = editorOver({ meditClient: client });
  const edit = async (address = EDITED) => { await commandHandlers.get('modbench.record.editField')?.(address, LEVEL); };
  return {
    client,
    showing: (formKey: string) => open(formKey),
    formKeyOf: (panel: FakePanel) => { panel.focus(); return askedFromThePalette(); },
    edit,
    moved: (newFormKey: string) => { client.setQueryAnswerOnce('getEditChanges', applied(newFormKey)); return edit(); },
    held: (address = EDITED) => {
      let answer!: (newFormKey: string | undefined) => void;
      client.setQueryAnswerOnce('getEditChanges', new Promise((resolve) => { answer = (newFormKey) => { resolve(applied(newFormKey)); }; }));
      return { editing: edit(address), answer };
    },
    sentTo: () => client.calls.filter(({ method }) => method === 'getEditChanges').map(({ args: [formKey] }) => formKey),
    read: async (panel: FakePanel, formKey: string, { columns = [] as unknown[], editorId = null as string | null } = {}) => {
      const compare = comparisonOf(formKey, [{ plugin: MOD.name, origin: MOD.origin, isWinner: true, editorId }]);
      client.setQueryAnswer('getComparison', compare);
      client.setQueryAnswer('getRecordsComparison', { compare, missing: [] });
      panel.receive({ type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey, columns });
      await settled(() => { expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recordLoadAnswered', requestId: 'r1' })); });
    },
  };
}

function openOn(formKey: string) {
  const tabs = tabsOver();
  return { ...tabs, panel: tabs.showing(formKey) };
}

describe('a record tab going with the record to its new FormKey and reading it there when mEdit reports the change and not before, keeping what it shows until then', () => {
  it('reads the new FormKey once mEdit reports it, when the answer lands first, and posts nothing before', async () => {
    const { client, panel, moved, formKeyOf } = openOn(OLD);

    await moved(NEW);

    expect(formKeyOf(panel)).toBe(NEW);
    expect(loadsOf(panel)).toEqual([]);
    client.change(rowsChanged([OLD, NEW]));
    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: NEW }]);
  });

  it('reads the new FormKey once, after the answer, when mEdit reports the change first', async () => {
    const { client, panel, held } = openOn(OLD);
    const { editing, answer } = held();

    client.change(rowsChanged([OLD, NEW]));
    expect(loadsOf(panel)).toEqual([]);
    answer(NEW);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: NEW }]);
  });

  it('reads the record it shows once, after the answer, for an edit that keeps its FormKey', async () => {
    const { client, panel, held } = openOn(OLD);
    const { editing, answer } = held();

    client.change(rowsChanged([OLD]));
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: OLD }]);
  });

  it('reads the record it shows once, after the answer, when mEdit reports a record it shows as a column changed', async () => {
    const { client, panel, held, read } = openOn(OLD);
    await read(panel, OLD, { columns: [{ formKey: ELSEWHERE, plugin: MOD }] });
    const { editing, answer } = held();

    client.change(rowsChanged([ELSEWHERE]));
    expect(loadsOf(panel)).toEqual([]);
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: OLD }]);
  });

  it('reads a tab again when mEdit refuses the load order, which the change event says as everything', () => {
    const { client, panel } = openOn(OLD);

    holdsLoadOrder(client, { settled: false, refusal: { kind: 'heldElsewhere', message: 'another window holds the record index' } });

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: OLD }]);
  });

  it('holds and follows every tab showing the record, for an edit fired with no tab, with one write', async () => {
    const { showing, moved, sentTo, formKeyOf } = tabsOver();
    const opened = [showing(OLD), showing(OLD), showing(ELSEWHERE)];

    await moved(NEW);

    expect(sentTo()).toEqual([OLD]);
    expect(opened.map(formKeyOf)).toEqual([NEW, NEW, ELSEWHERE]);
  });

  it('holds only the tabs showing the record, so a tab showing another reads it as soon as mEdit reports it', async () => {
    const { client, showing, held } = tabsOver();
    const [, elsewhere] = [showing(OLD), showing(ELSEWHERE)];
    const { editing, answer } = held();

    client.change(rowsChanged([ELSEWHERE]));
    const whileInFlight = loadsOf(elsewhere);
    answer(undefined);
    await editing;

    expect(whileInFlight).toEqual([{ type: 'loadRecord', formKey: ELSEWHERE }]);
  });

  it('sends an edit fired with no tab, addressed with the pre-move key, to the new key, holding and following the tab that moved', async () => {
    const { client, showing, moved, held, sentTo, formKeyOf } = tabsOver();
    const [tabMoved, elsewhere] = [showing(OLD), showing(ELSEWHERE)];
    await moved(NEW);
    const { editing, answer } = held();

    client.change(rowsChanged([OLD, NEW, NEW]));
    expect(loadsOf(tabMoved)).toEqual([]);
    answer('000a00:A.esp');
    await editing;

    expect(sentTo()).toEqual([OLD, NEW]);
    expect(formKeyOf(tabMoved)).toBe('000a00:A.esp');
    expect(loadsOf(elsewhere)).toEqual([]);
  });

  it('reads nothing into a tab closed while its edit was in flight, nor retitles it with the new FormKey', async () => {
    const { client, panel, held } = openOn(OLD);
    const { editing, answer } = held();
    client.change(rowsChanged([OLD, NEW]));

    panel.close();
    answer(NEW);
    await editing;

    expect(loadsOf(panel)).toEqual([]);
    expect(panel.title).toBe(OLD);
  });

  it('holds a refresh of the comparison between the answer and the report, which then reads the new FormKey', async () => {
    const { client, panel, moved } = openOn(OLD);

    await moved(NEW);
    settles(client);
    expect(loadsOf(panel)).toEqual([]);
    client.change(rowsChanged([OLD, NEW]));
    settles(client);

    expect(loadsOf(panel)).toEqual([
      { type: 'loadRecord', formKey: NEW },
      { type: 'loadRecord', formKey: NEW },
    ]);
  });

  it('refreshes the comparison after the answer when it was announced while an edit was in flight', async () => {
    const { client, panel, held } = openOn(OLD);
    const { editing, answer } = held();

    settles(client);
    expect(loadsOf(panel)).toEqual([]);
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: OLD }]);
  });

  it('reads once after the answer when both a report and a refresh were held by it', async () => {
    const { client, panel, held } = openOn(OLD);
    const { editing, answer } = held();

    client.change(rowsChanged([OLD]));
    settles(client);
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: OLD }]);
  });

  describe('a write addressed to the old FormKey, where an edit of the FormID moves the record in the one plugin it was made in', () => {
    it.each([
      ['in the moved plugin goes to the new FormKey, before the tab reads it', EDITED, NEW],
      ['in an override\'s column goes to its own old FormKey', { ...EDITED, plugin: 'Other.esp', origin: 'ModB' }, OLD],
      ['in the other plugin of that filename is untouched', { ...EDITED, origin: 'ModB' }, OLD],
    ])('%s', async (_, address, target) => {
      const { moved, edit, sentTo } = openOn(OLD);
      await moved(NEW);

      await edit(address);

      expect(sentTo()).toEqual([OLD, target]);
    });
  });

  describe('when mEdit re-derives a plugin whole, a tab waiting for its new FormKey, since no report names its key', () => {
    it('reads it once the Index holds it, and refreshes as usual afterwards', async () => {
      const { client, panel, moved } = openOn(OLD);
      client.setQueryAnswer('getRecordOwners', [MOD]);
      await moved(NEW);

      client.change(PLUGIN_CHANGED);
      await settled(() => expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: NEW }]));
      settles(client);

      expect(loadsOf(panel)).toEqual([
        { type: 'loadRecord', formKey: NEW },
        { type: 'loadRecord', formKey: NEW },
      ]);
    });

    it.each([
      ['while the Index does not hold it yet, since a read before would clear the grid for an error,',
        (client: InMemoryMEditClient) => { client.setQueryAnswer('getRecordOwners', []); }],
      ['when mEdit cannot say,', (client: InMemoryMEditClient) => { client.setQueryFailure('getRecordOwners', { failed: 'refused', refusal: 'backend down' }); }],
    ])('keeps what it shows %s and reads it on the report', async (_, answerOwner) => {
      const { client, panel, moved } = openOn(OLD);
      answerOwner(client);
      await moved(NEW);

      client.change(PLUGIN_CHANGED);
      await settled(() => expect(client.calls.some(c => c.method === 'getRecordOwners')).toBe(true));
      client.change(rowsChanged([OLD, NEW]));

      expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: NEW }]);
    });
  });

  describe('a change that says everything changed', () => {
    it('reads the record again when mEdit says the record index changed, as it does when it clears the record filter', () => {
      const { client, panel } = openOn(OLD);

      client.change(undefined);

      expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: OLD }]);
    });
  });

  it('ends every move of a chain of two when the tab reads the chain\'s last key, so a freed first key used again in the same plugin is its own record', async () => {
    const { client, panel, moved, edit, read, sentTo } = openOn(OLD);
    await moved(NEW);
    await moved('000A00:A.esp');
    client.change(rowsChanged([NEW, '000A00:A.esp']));
    await read(panel, '000A00:A.esp');

    await edit();

    expect(sentTo()).toEqual([OLD, NEW, OLD]);
  });

  it('retitles a tab titled with the old FormKey, and leaves one titled with the EditorID', async () => {
    const { showing, moved, read } = tabsOver();
    const [byFormKey, byEditorId] = [showing(OLD), showing(OLD)];
    await read(byEditorId, OLD, { editorId: 'MovedNpc' });

    await moved(NEW);

    expect(byFormKey.title).toBe(NEW);
    expect(byEditorId.title).toBe('MovedNpc');
  });
});
