import { describe, it, expect, vi } from 'vitest';
import { EditsInFlight } from '../followRecord';
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

const EDITED_MOD_ESP_FROM_MODA = { formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'ModA' };

const rowsChanged = (keys: string[]) =>
  ({ kind: 'rows-changed' as const, plugin: 'Mod.esp', origin: 'ModA', keys, sequence: 2 });

const loadsOf = (panel: ReturnType<typeof fakePanel>) => (panel.webview.postMessage.mock.calls as unknown[][]).map(([m]) => m);

function writeAnsweredWhenTheTestChooses() {
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
  subscribeRecordPanelsToNotifications(client, new Set([panel]), edits);
  return { client, panel, tracker, edits };
}

describe('EditsInFlight, the tab going with the record to its new FormKey and reading it there when mEdit reports the change and not before, keeping what it shows until then', () => {
  it('reads the new FormKey once mEdit reports it, when the answer lands first, and posts nothing before', async () => {
    const { client, panel, tracker, edits } = openOn('000800:Mod.esp');

    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

    expect(tracker.formKeyOf(panel)).toBe('000900:Mod.esp');
    expect(loadsOf(panel)).toEqual([]);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
  });

  it('reads the new FormKey once, after the answer, when mEdit reports the change first', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = writeAnsweredWhenTheTestChooses();

    const editing = edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, write);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(panel)).toEqual([]);
    answer('000900:Mod.esp');
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
  });

  it('reads the record it shows once, after the answer, for an edit that keeps its FormKey', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = writeAnsweredWhenTheTestChooses();

    const editing = edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, write);
    client.emit(rowsChanged(['000800:Mod.esp']));
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
  });

  it('gateShowing holds and follows every panel showing the record with one write', async () => {
    const tracker = fakeActiveRecordTracker();
    const [first, second, elsewhere] = [fakePanel('a'), fakePanel('b'), fakePanel('c')];
    tracker.setFormKey(first, '000800:Mod.esp');
    tracker.setFormKey(second, '000800:Mod.esp');
    tracker.setFormKey(elsewhere, '000801:Mod.esp');
    const edits = new EditsInFlight(tracker);
    const write = vi.fn(() => Promise.resolve<string | undefined>('000900:Mod.esp'));

    await edits.gateShowing([first, second, elsewhere], EDITED_MOD_ESP_FROM_MODA)(EDITED_MOD_ESP_FROM_MODA, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect([first, second, elsewhere].map(panel => tracker.formKeyOf(panel)))
      .toEqual(['000900:Mod.esp', '000900:Mod.esp', '000801:Mod.esp']);
  });

  it('gateShowing sends an edit addressed with the pre-move key to the new key, holding and following the panel that moved', async () => {
    const client = new InMemoryMEditClient();
    const moved = fakePanel('a');
    const elsewhere = fakePanel('c');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(moved, '000800:Mod.esp');
    tracker.setFormKey(elsewhere, '000801:Mod.esp');
    const edits = new EditsInFlight(tracker);
    subscribeRecordPanelsToNotifications(client, new Set([moved, elsewhere]), edits);
    const panels = [moved, elsewhere];
    await edits.gateShowing(panels, EDITED_MOD_ESP_FROM_MODA)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));
    const { write, answer } = writeAnsweredWhenTheTestChooses();
    const written: string[] = [];

    const stale = edits.gateShowing(panels, EDITED_MOD_ESP_FROM_MODA)(EDITED_MOD_ESP_FROM_MODA, key => { written.push(key); return write(); });
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(moved)).toEqual([]);
    answer('000a00:Mod.esp');
    await stale;

    expect(written).toEqual(['000900:Mod.esp']);
    expect(tracker.formKeyOf(moved)).toBe('000a00:Mod.esp');
    expect(loadsOf(elsewhere)).toEqual([]);
  });

  it('holds only the panel whose edit is in flight', async () => {
    const client = new InMemoryMEditClient();
    const editing = fakePanel('MovedNpc');
    const other = fakePanel('MovedNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(editing, '000800:Mod.esp');
    tracker.setFormKey(other, '000800:Mod.esp');
    const edits = new EditsInFlight(tracker);
    subscribeRecordPanelsToNotifications(client, new Set([editing, other]), edits);
    const { write, answer } = writeAnsweredWhenTheTestChooses();

    const edit = edits.gate(editing)(EDITED_MOD_ESP_FROM_MODA, write);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    answer('000900:Mod.esp');
    await edit;

    expect(loadsOf(other)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
    expect(tracker.formKeyOf(other)).toBe('000800:Mod.esp');
  });

  it('holds a refresh of the comparison between the answer and the report, which then reads the new FormKey', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');

    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));
    announceConflictsComputed(new Set([panel]), edits);
    expect(loadsOf(panel)).toEqual([]);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    announceConflictsComputed(new Set([panel]), edits);

    expect(loadsOf(panel)).toEqual([
      { type: 'loadRecord', formKey: '000900:Mod.esp' },
      { type: 'loadRecord', formKey: '000900:Mod.esp' },
    ]);
  });

  it('refreshes the comparison after the answer when it was announced while an edit was in flight', async () => {
    const { panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = writeAnsweredWhenTheTestChooses();

    const editing = edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, write);
    announceConflictsComputed(new Set([panel]), edits);
    expect(loadsOf(panel)).toEqual([]);
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
  });

  it('reads once after the answer when both a report and a refresh were held by it', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = writeAnsweredWhenTheTestChooses();

    const editing = edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, write);
    client.emit(rowsChanged(['000800:Mod.esp']));
    announceConflictsComputed(new Set([panel]), edits);
    answer(undefined);
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
  });

  describe('a write addressed to the old FormKey, where an edit of the FormID moves the record in the one plugin it was made in', () => {
    const sentTo = async (edits: EditsInFlight<ReturnType<typeof fakePanel>>, panel: ReturnType<typeof fakePanel>,
      address: typeof EDITED_MOD_ESP_FROM_MODA, gate = edits.gate(panel)) => {
      const targets: string[] = [];
      await gate(address, formKey => { targets.push(formKey); return Promise.resolve(undefined); });
      return targets;
    };

    it('in the moved plugin goes to the new FormKey, before the tab reads it', async () => {
      const { panel, edits } = openOn('000800:Mod.esp');
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

      expect(await sentTo(edits, panel, EDITED_MOD_ESP_FROM_MODA)).toEqual(['000900:Mod.esp']);
    });

    it('in an override\'s column goes to its own old FormKey', async () => {
      const { panel, edits } = openOn('000800:Mod.esp');
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

      expect(await sentTo(edits, panel, { ...EDITED_MOD_ESP_FROM_MODA, plugin: 'Other.esp', origin: 'ModB' })).toEqual(['000800:Mod.esp']);
    });

    it('in the other plugin of that filename is untouched', async () => {
      const { panel, edits } = openOn('000800:Mod.esp');
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

      expect(await sentTo(edits, panel, { ...EDITED_MOD_ESP_FROM_MODA, origin: 'ModB' })).toEqual(['000800:Mod.esp']);
    });

    it('from a gate taken before the move goes to the new FormKey after the tab reads it (an extended editor keeps the address it was opened on), and one taken after does not', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      const openedBefore = edits.gate(panel);
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));
      client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
      edits.answered(panel, '000900:Mod.esp');

      expect(await sentTo(edits, panel, EDITED_MOD_ESP_FROM_MODA, openedBefore)).toEqual(['000900:Mod.esp']);
      expect(await sentTo(edits, panel, EDITED_MOD_ESP_FROM_MODA)).toEqual(['000800:Mod.esp']);
    });
  });

  it('forgets a closed panel: nothing of it is held or sent elsewhere', async () => {
    const { panel, edits } = openOn('000800:Mod.esp');
    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

    edits.forget(panel);

    edits.refresh(panel);
    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
    const targets: string[] = [];
    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, formKey => { targets.push(formKey); return Promise.resolve(undefined); });
    expect(targets).toEqual(['000800:Mod.esp']);
  });

  describe('on the stream\'s reconnect, a tab waiting for its new FormKey, since a report missed while the stream was down would leave it waiting for ever', () => {
    it('reads it once the Index holds it, and refreshes as usual afterwards', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      client.setQueryAnswer('getRecordOwner', { plugin: 'Mod.esp', origin: 'ModA' });
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

      client.reconnected();
      await vi.waitFor(() => expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]));
      announceConflictsComputed(new Set([panel]), edits);

      expect(loadsOf(panel)).toEqual([
        { type: 'loadRecord', formKey: '000900:Mod.esp' },
        { type: 'loadRecord', formKey: '000900:Mod.esp' },
      ]);
    });

    it('keeps what it shows while the Index does not hold it yet, since a read before would clear the grid for an error, and reads it on the report', async () => {
      const { client, panel, edits } = openOn('000800:Mod.esp');
      client.setQueryAnswer('getRecordOwner', undefined);
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

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
      await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

      client.reconnected();
      await vi.waitFor(() => expect(client.calls.some(c => c.method === 'getRecordOwner')).toBe(true));
      await Promise.resolve();
      expect(loadsOf(panel)).toEqual([]);
      client.emit(rowsChanged(['000900:Mod.esp']));

      expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
    });
  });

  it('ends every move of a chain of two when the tab reads the chain\'s last key, so a freed first key used again in the same plugin is its own record', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));
    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000A00:Mod.esp'));
    client.emit(rowsChanged(['000900:Mod.esp', '000A00:Mod.esp']));
    edits.answered(panel, '000A00:Mod.esp');

    const targets: string[] = [];
    await edits.gate(panel)(EDITED_MOD_ESP_FROM_MODA, formKey => { targets.push(formKey); return Promise.resolve(undefined); });

    expect(targets).toEqual(['000800:Mod.esp']);
  });

  it('retitles a tab titled with the old FormKey, and leaves one titled with the EditorID', async () => {
    const byFormKey = openOn('000800:Mod.esp', '000800:Mod.esp');
    const byEditorId = openOn('000800:Mod.esp', 'MovedNpc');

    await byFormKey.edits.gate(byFormKey.panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));
    await byEditorId.edits.gate(byEditorId.panel)(EDITED_MOD_ESP_FROM_MODA, () => Promise.resolve('000900:Mod.esp'));

    expect(byFormKey.panel.title).toBe('000900:Mod.esp');
    expect(byEditorId.panel.title).toBe('MovedNpc');
  });
});
