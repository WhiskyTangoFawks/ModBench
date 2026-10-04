import type { LoadOrderSender, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';

type StatusSource = Pick<MEditClient, 'onStatusChanged'>;

/** A send in flight when mEdit went reports abandoned, never a killed backend as a network
 *  failure. Returns the unsubscribe. */
export function abandonSendWhenMEditGoes(client: StatusSource, sender: Pick<LoadOrderSender, 'abandon'>): () => void {
  return client.onStatusChanged((status) => {
    if (status === 'disconnected' || status === 'stopped') sender.abandon();
  });
}

/** A crash-restart is a fresh backend holding no load order, so the reconcile runs again from
 *  scratch — the same re-entry path a fresh launch takes, not a bespoke recovery. */
export function enterEditingAcrossRestarts(
  client: StatusSource, enterEditing: () => Promise<void>, log: (msg: string) => void,
): { enter: () => Promise<void>; dispose: () => void } {
  // A `disconnected` nobody asked for is the crash; the `running` after it is the fresh
  // process. Cleared by every deliberate entry, so a relaunch is not also read as a restart.
  let crashed = false;
  const enter = () => { crashed = false; return enterEditing(); };
  const unsubscribe = client.onStatusChanged((status) => {
    if (status === 'disconnected') { crashed = true; return; }
    if (status !== 'running' || !crashed) return;
    void enter().catch((err: unknown) =>
      log(`reload after backend restart failed: ${errorMessage(err)}`),
    );
  });
  return { enter, dispose: unsubscribe };
}
