import type { MEditClient } from '../client';

// Each rows-changed event (ADR-0015) re-reads the whole tree, which has no per-row
// identity to check it against. The plugin facts too, as a changed record can start or stop
// matching the record filter.
export function subscribeTreeToNotifications(
  client: Pick<MEditClient, 'onNotification'>, tree: { refresh(): void }, refreshPluginFacts: () => void,
): () => void {
  const reread = () => { tree.refresh(); refreshPluginFacts(); };
  const unsubscribeRows = client.onNotification('rows-changed', reread);
  const unsubscribePlugin = client.onNotification('plugin-changed', reread);
  return () => { unsubscribeRows(); unsubscribePlugin(); };
}
