import type { NotificationEvent } from '../../client/apiClient';
import { describe, it, expect, vi } from 'vitest';
import { subscribeTreeToNotifications } from '../treeNotifications';
import { InMemoryMEditClient } from '../../client';

function rowsChanged(keys: string[]): NotificationEvent {
  return { kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys, sequence: 1 };
}

function pluginChanged(): NotificationEvent {
  return { kind: 'plugin-changed', plugin: 'Test.esp', origin: 'ModA', keys: [], sequence: 1 };
}

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
