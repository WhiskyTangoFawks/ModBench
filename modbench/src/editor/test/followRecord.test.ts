import { describe, it, expect, vi } from 'vitest';
import { EditsInFlight } from '../followRecord';
import { subscribeRecordPanelsToNotifications } from '../../medit/notificationWiring';
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

    await edits.edit(panel, '000800:Mod.esp', () => Promise.resolve('000900:Mod.esp'));

    expect(tracker.formKeyOf(panel)).toBe('000900:Mod.esp');
    expect(loadsOf(panel)).toEqual([]);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
  });

  it('reads the new FormKey once, after the answer, when mEdit reports the change first', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = pendingAnswer();

    const editing = edits.edit(panel, '000800:Mod.esp', write);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    expect(loadsOf(panel)).toEqual([]);
    answer('000900:Mod.esp');
    await editing;

    expect(loadsOf(panel)).toEqual([{ type: 'loadRecord', formKey: '000900:Mod.esp' }]);
  });

  it('reads the record it shows once, after the answer, for an edit that keeps its FormKey', async () => {
    const { client, panel, edits } = openOn('000800:Mod.esp');
    const { write, answer } = pendingAnswer();

    const editing = edits.edit(panel, '000800:Mod.esp', write);
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

    const edit = edits.edit(editing, '000800:Mod.esp', write);
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    answer('000900:Mod.esp');
    await edit;

    expect(loadsOf(other)).toEqual([{ type: 'loadRecord', formKey: '000800:Mod.esp' }]);
    expect(tracker.formKeyOf(other)).toBe('000800:Mod.esp');
  });

  it('retitles a tab titled with the old FormKey, and leaves one titled with the EditorID', async () => {
    const byFormKey = openOn('000800:Mod.esp', '000800:Mod.esp');
    const byEditorId = openOn('000800:Mod.esp', 'MovedNpc');

    await byFormKey.edits.edit(byFormKey.panel, '000800:Mod.esp', () => Promise.resolve('000900:Mod.esp'));
    await byEditorId.edits.edit(byEditorId.panel, '000800:Mod.esp', () => Promise.resolve('000900:Mod.esp'));

    expect(byFormKey.panel.title).toBe('000900:Mod.esp');
    expect(byEditorId.panel.title).toBe('MovedNpc');
  });
});
