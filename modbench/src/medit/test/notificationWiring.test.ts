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

function fakeActiveRecordTrackerOfJustFormKeyOf() {
  const formKeys = new Map<unknown, string>();
  return {
    setFormKey(panel: unknown, formKey: string) { formKeys.set(panel, formKey); },
    formKeyOf(panel: unknown) { return formKeys.get(panel); },
  };
}

const gateHoldingNoReadSinceNoEditIsInFlight = {holds: () => false, waitingFor: () => undefined, release: () => false };

describe('subscribeRecordPanelsToNotifications', () => {
  it('rows-changed naming the panel\'s own FormKey re-reads that one panel', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTrackerOfJustFormKeyOf();
    tracker.setFormKey(panel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker, gateHoldingNoReadSinceNoEditIsInFlight);

    client.emit(rowsChanged(['000001:Test.esp']));

    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: '000001:Test.esp' });
  });

  it('rows-changed naming a different FormKey re-reads nothing', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTrackerOfJustFormKeyOf();
    tracker.setFormKey(panel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker, gateHoldingNoReadSinceNoEditIsInFlight);

    client.emit(rowsChanged(['000002:Other.esp']));

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('plugin-changed never reaches a record panel — only rows-changed does', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTrackerOfJustFormKeyOf();
    tracker.setFormKey(panel, '000001:Test.esp');
    subscribeRecordPanelsToNotifications(client, recordPanels, tracker, gateHoldingNoReadSinceNoEditIsInFlight);

    client.emit(pluginChanged());

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('unsubscribing stops further re-reads', () => {
    const client = new InMemoryMEditClient();
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTrackerOfJustFormKeyOf();
    tracker.setFormKey(panel, '000001:Test.esp');
    const unsubscribe = subscribeRecordPanelsToNotifications(client, recordPanels, tracker, gateHoldingNoReadSinceNoEditIsInFlight);

    unsubscribe();
    client.emit(rowsChanged(['000001:Test.esp']));

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('subscribeTreeToNotifications', () => {
  it('re-reads the records and the plugin facts a record filter\'s match reads on rows-changed', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    const refreshPluginFacts = vi.fn();
    subscribeTreeToNotifications(client, tree, refreshPluginFacts);

    client.emit(rowsChanged(['000001:Test.esp']));

    expect(tree.refresh).toHaveBeenCalledTimes(1);
    expect(refreshPluginFacts).toHaveBeenCalledTimes(1);
  });

  it('re-reads the records and the plugin facts on plugin-changed', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    const refreshPluginFacts = vi.fn();
    subscribeTreeToNotifications(client, tree, refreshPluginFacts);

    client.emit(pluginChanged());

    expect(tree.refresh).toHaveBeenCalledTimes(1);
    expect(refreshPluginFacts).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops both subscriptions', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    const refreshPluginFacts = vi.fn();
    const unsubscribe = subscribeTreeToNotifications(client, tree, refreshPluginFacts);

    unsubscribe();
    client.emit(rowsChanged(['000001:Test.esp']));
    client.emit(pluginChanged());

    expect(tree.refresh).not.toHaveBeenCalled();
    expect(refreshPluginFacts).not.toHaveBeenCalled();
  });
});
