import { describe, it, expect, vi } from 'vitest';
import { EditsInFlight } from '../../editor/followRecord';
import { announceConflictsComputed, subscribeRecordPanelsToNotifications } from '../notificationWiring';
import { InMemoryMEditClient } from '../../client';

function fakePanel(title: string) {
  return { title, webview: { postMessage: vi.fn(() => Promise.resolve(true)) } };
}

function fakeActiveRecordTracker() {
  const formKeys = new Map<unknown, string>();
  return {
    setFormKey(panel: unknown, formKey: string) { formKeys.set(panel, formKey); },
    formKeyOf(panel: unknown) { return formKeys.get(panel); },
  };
}

// Where the edits are made: Mod.esp from ModA.
const EDITED = { formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA' };

const rowsChanged = (keys: string[]) =>
  ({ kind: 'rows-changed' as const, plugin: 'Mod.esp', origin: 'ModA', keys, sequence: 2 });

const loadsOf = (panel: ReturnType<typeof fakePanel>) => (panel.webview.postMessage.mock.calls as unknown[][]).map(([m]) => m);

// A write whose answer the test settles when it chooses.
function pendingAnswer() {
  let answer!: (newFormKey: string | undefined) => void;
  const answered = new Promise<string | undefined>(resolve => { answer = resolve; });
  return { write: () => answered, answer };
}

function openOn(formKey: string, title = 'MovedNpc') {
  const client = new InMemoryMEditClient();
  const panel = fakePanel(title);
  const tracker = fakeActiveRecordTracker();
  tracker.setFormKey(panel, formKey);
  const edits = new EditsInFlight(tracker);
  subscribeRecordPanelsToNotifications(client, new Set([panel]), tracker, edits);
  return { client, panel, tracker, edits };
}

// editor.md, The FormID and States 5: the tab goes with the record to its new FormKey, and reads
// it there when mEdit reports the change, and not before; until then it keeps what it shows
// (common.md, Unconfirmed writes).
describe('EditsInFlight', () => {
  it('reads the new FormKey once mEdit reports it, when the answer lands first, and posts nothing before', async () => {
    const { client, panel, tracker, edits } = openOn('000800:Mod.esp');

    await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

    expect(tracker.formKeyOf(panel)).toBe('000900:Mod.esp');
    expect(loadsOf(panel)).toEqual([]);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
  });

  it('reads the new FormKey once, after the answer, when mEdit reports the change first', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = pendingAnswer();

    const editing = edits.gate(panel)(EDITED, write);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(panel)).toEqual([]);
    answer('000900:Mod.esp');
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
  });

  it('reads the record it shows once, after the answer, for an edit that keeps its FormKey', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = pendingAnswer();

    const editing = edits.gate(panel)(EDITED, write);
    client.emit(rowsChanged(['000800:Mod.esp']));
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
  });

  it('holds only the panel whose edit is in flight', async () => {
    const client = new InMemoryMEditClient();
    const editing = fakePanel('MovedNpc');
    const other = fakePanel('MovedNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(editing, '000800:Mod.esp');
    tracker.setFormKey(other, '000800:Mod.esp');
    const edits = new EditsInFlight(tracker);
    subscribeRecordPanelsToNotifications(client, new Set([editing, other]), tracker, edits);
    const { write, answer } = pendingAnswer();

    const edit = edits.gate(editing)(EDITED, write);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    answer('000900:Mod.esp');
    await edit;

    expect(loadsOf(other)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
    expect(tracker.formKeyOf(other)).toBe('000800:Mod.esp');
  });

  // Between the answer and the report, the Index does not hold the new key yet and the old one is
  // gone, so the tab's refresh waits for the read the report brings.
  it('holds a refresh of the comparison between the answer and the report, which then reads the new FormKey', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');

    await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));
    announceConflictsComputed(new Set([panel]), edits);
    expect(loadsOf(panel)).toEqual([]);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    announceConflictsComputed(new Set([panel]), edits);

    expect(loadsOf(panel)).toEqual([
      { type: 'loadRecord', formKey: '000900:Mod.esp' },
      { type: 'conflictsComputed' },
    ]);
  });

  it('refreshes the comparison after the answer when it was announced while an edit was in flight', async () => {
    const { panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = pendingAnswer();

    const editing = edits.gate(panel)(EDITED, write);
    announceConflictsComputed(new Set([panel]), edits);
    expect(loadsOf(panel)).toEqual([]);
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'conflictsComputed' }]);
  });

  // ADR-0012 invariant 1: an edit of the FormID moves the record in the one plugin it was made in.
  // The override in another plugin, and the other plugin named Mod.esp, stay under the old FormKey.
  describe('a write addressed to the old FormKey', () => {
    const sentTo = async (edits: EditsInFlight<ReturnType<typeof fakePanel>>, panel: ReturnType<typeof fakePanel>,
      address: typeof EDITED, gate = edits.gate(panel)) => {
      const targets: string[] = [];
      await gate(address, formKey => { targets.push(formKey); return Promise.resolve(undefined); });
      return targets;
    };

    it('in the moved plugin goes to the new FormKey, before the tab reads it', async () => {
      const { panel, edits } = openOn('000800:Mod.esp');
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

      expect(await sentTo(edits, panel, EDITED)).toEqual(['000900:Mod.esp']);
    });

    it('in an override\'s column goes to its own old FormKey', async () => {
      const { panel, edits } = openOn('000800:Mod.esp');
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

      expect(await sentTo(edits, panel, { ...EDITED, plugin: 'Other.esp', origin: 'ModB' })).toEqual(['000800:Mod.esp']);
    });

    it('in the other plugin of that filename is untouched', async () => {
      const { panel, edits } = openOn('000800:Mod.esp');
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

      expect(await sentTo(edits, panel, { ...EDITED, origin: 'ModB' })).toEqual(['000800:Mod.esp']);
    });

    // An extended editor keeps the address it was opened on, so its saves follow the move
    // however late they come; a write addressed after the tab reads the new key names what it means.
    it('from a gate taken before the move goes to the new FormKey after the tab reads it, and one taken after does not', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      const openedBefore = edits.gate(panel);
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));
      client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));

      expect(await sentTo(edits, panel, EDITED, openedBefore)).toEqual(['000900:Mod.esp']);
      expect(await sentTo(edits, panel, EDITED)).toEqual(['000800:Mod.esp']);
    });
  });

  it('forgets a closed panel: nothing of it is held or sent elsewhere', async () => {
    const { panel, edits } = openOn('000800:Mod.esp');
    await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

    edits.forget(panel);

    expect(edits.holdsRefresh(panel)).toBe(false);
    const targets: string[] = [];
    await edits.gate(panel)(EDITED, formKey => { targets.push(formKey); return Promise.resolve(undefined); });
    expect(targets).toEqual(['000800:Mod.esp']);
  });

  // A report missed while the stream was down would leave the tab waiting for ever; a read before
  // the Index holds the key would clear the grid for an error (editor.md, States 5).
  describe('on the stream\'s reconnect, a tab waiting for its new FormKey', () => {
    it('reads it once the Index holds it, and refreshes as usual afterwards', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      client.setQueryAnswer('getRecordOwner', { plugin: 'Mod.esp', origin: 'ModA' });
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

      client.reconnected();
      await vi.waitFor(() => expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]));
      announceConflictsComputed(new Set([panel]), edits);

      expect(loadsOf(panel)).toEqual([
        { type: 'loadRecord', formKey: '000900:Mod.esp' },
        { type: 'conflictsComputed' },
      ]);
    });

    it('keeps what it shows while the Index does not hold it yet, and reads it on the report', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      client.setQueryAnswer('getRecordOwner', undefined);
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

      client.reconnected();
      await vi.waitFor(() => expect(client.calls.some(c => c.method === 'getRecordOwner')).toBe(true));
      await Promise.resolve();
      expect(loadsOf(panel)).toEqual([]);
      client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));

      expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
    });

    it('keeps what it shows when mEdit cannot say, and reads it on the report', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      client.setQueryFailure('getRecordOwner', new Error('backend down'));
      await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

      client.reconnected();
      await vi.waitFor(() => expect(client.calls.some(c => c.method === 'getRecordOwner')).toBe(true));
      await Promise.resolve();
      expect(loadsOf(panel)).toEqual([]);
      client.emit(rowsChanged(['000900:Mod.esp']));

      expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
    });
  });

  // A FormID changed twice before the tab read either key: its read of the last one ends the
  // whole chain, so a freed first key used again in the same plugin is its own record.
  it('ends every move of a chain when the tab reads the chain\'s last key', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    await edits.gate(panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));
    await edits.gate(panel)(EDITED, () => Promise.resolve('000A00:Mod.esp'));
    client.emit(rowsChanged(['000900:Mod.esp', '000A00:Mod.esp']));

    const targets: string[] = [];
    await edits.gate(panel)(EDITED, formKey => { targets.push(formKey); return Promise.resolve(undefined); });

    expect(targets).toEqual(['000800:Mod.esp']);
  });

  it('retitles a tab titled with the old FormKey, and leaves one titled with the EditorID', async () => {
    const byFormKey = openOn('000800:Mod.esp', '000800:Mod.esp');
    const byEditorId = openOn('000800:Mod.esp', 'MovedNpc');

    await byFormKey.edits.gate(byFormKey.panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));
    await byEditorId.edits.gate(byEditorId.panel)(EDITED, () => Promise.resolve('000900:Mod.esp'));

    expect(byFormKey.panel.title).toBe('000900:Mod.esp');
    expect(byEditorId.panel.title).toBe('MovedNpc');
  });
});
