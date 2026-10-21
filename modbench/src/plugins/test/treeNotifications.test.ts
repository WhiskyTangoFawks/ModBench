import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { subscribeTreeToNotifications } from '../treeNotifications';

describe('subscribeTreeToNotifications', () => {
  it('reads the tree and the plugin facts again when the connection reopens', () => {
    const client = new InMemoryMEditClient();
    const tree = { refresh: vi.fn() };
    const refreshPluginFacts = vi.fn();
    subscribeTreeToNotifications(client, tree, refreshPluginFacts);

    client.reconnected();

    expect(tree.refresh).toHaveBeenCalledTimes(1);
    expect(refreshPluginFacts).toHaveBeenCalledTimes(1);
  });
});
