import { describe, it, expect, vi } from 'vitest';
import { followRecordInPanels } from '../followRecord';
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

// editor.md, The FormID: the Index reads the record again under its new FormKey, and the tab goes
// with it; the read itself waits for mEdit's report (ADR-0015, invariant 3).
describe('followRecordInPanels', () => {
  it('points a tab showing the record at its new FormKey, which it reads once mEdit reports the change', () => {
    const client = new InMemoryMEditClient();
    const moved = fakePanel('MovedNpc');
    const other = fakePanel('OtherNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(moved, '000800:Mod.esp');
    tracker.setFormKey(other, '000801:Mod.esp');
    const recordPanels = new Set([moved, other]);
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker);

    followRecordInPanels(recordPanels, tracker, '000800:Mod.esp', '000900:Mod.esp');

    expect(moved.webview.postMessage).not.toHaveBeenCalled();
    client.emit({ kind: 'plugin-changed', plugin: 'Mod.esp', origin: 'ModA', keys: [], sequence: 2 });
    expect(moved.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: '000900:Mod.esp' }]]);
    expect(other.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: '000801:Mod.esp' }]]);
  });

  it('retitles a tab titled with the old FormKey, and leaves one titled with the EditorID', () => {
    const byFormKey = fakePanel('000800:Mod.esp');
    const byEditorId = fakePanel('MovedNpc');
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(byFormKey, '000800:Mod.esp');
    tracker.setFormKey(byEditorId, '000800:Mod.esp');

    followRecordInPanels([byFormKey, byEditorId], tracker, '000800:Mod.esp', '000900:Mod.esp');

    expect(byFormKey.title).toBe('000900:Mod.esp');
    expect(byEditorId.title).toBe('MovedNpc');
  });
});
