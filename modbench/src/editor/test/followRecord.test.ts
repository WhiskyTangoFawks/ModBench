import { describe, it, expect, vi } from 'vitest';
import { followRecordInPanel } from '../followRecord';
import { subscribeRecordPanelsToNotifications } from '../../medit/notificationWiring';
import { InMemoryMEditClient } from '../../client';

function fakePanel(title: string) {
  return { title, webview: { postMessage: vi.fn() } };
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

const loadsOf = (panel: ReturnType<typeof fakePanel>) => panel.webview.postMessage.mock.calls.map(([m]) => m as unknown);

// editor.md, The FormID: the Index reads the record again under its new FormKey, and the tab the
// edit came from goes with it.
describe('followRecordInPanel', () => {
  it('reads the record under its new FormKey when the answer lands before mEdit reports the change', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel('MovedNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000800:Mod.esp');
    subscribeRecordPanelsToNotifications(client, new Set([panel]), tracker);

    followRecordInPanel(panel, tracker, '000800:Mod.esp', '000900:Mod.esp');
    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));

    expect(loadsOf(panel).at(-1)).toEqual({ type: 'loadRecord', formKey: '000900:Mod.esp' });
    expect(tracker.formKeyOf(panel)).toBe('000900:Mod.esp');
  });

  // The rival: moving the tracker alone, which leaves the tab showing the old record, read on the
  // report that came first, while its next edit names the old FormKey.
  it('reads the record under its new FormKey when mEdit reports the change before the answer lands', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel('MovedNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000800:Mod.esp');
    subscribeRecordPanelsToNotifications(client, new Set([panel]), tracker);

    client.emit(rowsChanged(['000800:Mod.esp', '000900:Mod.esp']));
    followRecordInPanel(panel, tracker, '000800:Mod.esp', '000900:Mod.esp');

    expect(loadsOf(panel).at(-1)).toEqual({ type: 'loadRecord', formKey: '000900:Mod.esp' });
  });

  it('leaves a tab that has moved on to another record where it is', () => {
    const panel = fakePanel('OtherNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000801:Mod.esp');

    followRecordInPanel(panel, tracker, '000800:Mod.esp', '000900:Mod.esp');

    expect(tracker.formKeyOf(panel)).toBe('000801:Mod.esp');
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('retitles a tab titled with the old FormKey, and leaves one titled with the EditorID', () => {
    const byFormKey = fakePanel('000800:Mod.esp');
    const byEditorId = fakePanel('MovedNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(byFormKey, '000800:Mod.esp');
    tracker.setFormKey(byEditorId, '000800:Mod.esp');

    followRecordInPanel(byFormKey, tracker, '000800:Mod.esp', '000900:Mod.esp');
    followRecordInPanel(byEditorId, tracker, '000800:Mod.esp', '000900:Mod.esp');

    expect(byFormKey.title).toBe('000900:Mod.esp');
    expect(byEditorId.title).toBe('MovedNpc');
  });
});
