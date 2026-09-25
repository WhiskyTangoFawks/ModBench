import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
}));

import { subscribeTreeToNotifications, subscribeRecordPanelsToNotifications } from '../notificationWiring';
import { InMemoryMEditClient, type NotificationEvent } from '../../client';

function rowsChanged(keys: string[], overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys, sequence: 1, ...overrides };
}

function pluginChanged(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { kind: 'plugin-changed', plugin: 'Test.esp', origin: 'ModA', keys: [], sequence: 1, ...overrides };
}

function fakePanel(): { webview: { postMessage: ReturnType<typeof vi.fn> } } {
  return { webview: { postMessage: vi.fn() } };
}

// A bare stand-in for Editor's `ActiveRecordTracker` — this suite pins the wiring's own exports,
// which take the tracker structurally (just `formKeyOf`).
function fakeActiveRecordTracker() {
  const formKeys = new Map<unknown, string>();
  return {
    setFormKey(panel: unknown, formKey: string) { formKeys.set(panel, formKey); },
    formKeyOf(panel: unknown) { return formKeys.get(panel); },
  };
}

describe('subscribeRecordPanelsToNotifications', () => {
  it('rows-changed naming the panel\'s own FormKey re-reads that one panel', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker);

    client.emit(rowsChanged(['000001:Test.esp']));

    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: '000001:Test.esp' });
  });

  it('rows-changed naming a different FormKey re-reads nothing', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker);

    client.emit(rowsChanged(['000002:Other.esp']));

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  // A plugin read again whole names no rows, so any record it holds may have changed, a record
  // that moved to a new FormKey among them.
  it('plugin-changed re-reads every record panel, each under its own FormKey', () => {
    const client = new InMemoryMEditClient();
    const first = fakePanel();
    const second = fakePanel();
    const recordPanels = new Set([first, second]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(first, '000001:Test.esp');
    tracker.setFormKey(second, '000002:Other.esp');
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker);

    client.emit(pluginChanged());

    expect(first.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: '000001:Test.esp' }]]);
    expect(second.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: '000002:Other.esp' }]]);
  });

  it('plugin-changed re-reads nothing in a panel that shows no record yet', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    subscribeRecordPanelsToNotifications(client, new Set([panel]), fakeActiveRecordTracker());

    client.emit(pluginChanged());

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('unsubscribing stops further re-reads', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, '000001:Test.esp');
    const unsubscribe = subscribeRecordPanelsToNotifications(client, recordPanels, tracker);

    unsubscribe();
    client.emit(rowsChanged(['000001:Test.esp']));
    client.emit(pluginChanged());

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('subscribeTreeToNotifications', () => {
  it('refreshes on rows-changed', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    subscribeTreeToNotifications(client, tree);

    client.emit(rowsChanged(['000001:Test.esp']));

    expect(tree.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes on plugin-changed', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    subscribeTreeToNotifications(client, tree);

    client.emit(pluginChanged());

    expect(tree.refresh).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops both subscriptions', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    const unsubscribe = subscribeTreeToNotifications(client, tree);

    unsubscribe();
    client.emit(rowsChanged(['000001:Test.esp']));
    client.emit(pluginChanged());

    expect(tree.refresh).not.toHaveBeenCalled();
  });
});
