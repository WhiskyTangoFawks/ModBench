import type { BackendStatus, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';

type StatusSource = Pick<MEditClient, 'onStatusChanged'>;

// The four backend states the status bar item shows (common.md, The status bar); the
// fifth, Ready, is the reconcile's own (`loadOrderOutcome.ts`).
const STATUS_TEXT: Record<BackendStatus, string> = {
  starting:     '$(loading~spin) mEdit: Connecting…',
  attached:     '$(plug) mEdit: Attached',
  disconnected: '$(error) mEdit: Disconnected — start MEditService and reload',
  stopped:      '$(circle-slash) mEdit: Stopped',
};

export function backendStatusText(status: BackendStatus): string {
  return STATUS_TEXT[status];
}

// plugins.md, States 3: the Plugins tree's own wording for the two states that make a row not
// yet held unreachable — plain, no icon, no colon-prefixed "mEdit:".
const UNREACHABLE_REASON: Record<'disconnected' | 'stopped', string> = {
  disconnected: 'mEdit is disconnected — start MEditService and reload.',
  stopped: 'mEdit is stopped.',
};

export interface BackendStatusViews {
  /** The one status bar item's text. */
  setStatusText: (text: string) => void;
  /** The reconcile in flight when the backend went, so it reports abandoned rather than
   *  reporting a killed backend to the user as a network failure. */
  abandonReconcile: () => void;
  /** The Plugins tree re-reads its own facts. Its rows stay, and expand into the error node. */
  refreshTree: () => void;
  /** plugins.md, States 3: the Plugins tree names this on a row not yet held, until a later
   *  tick or reconcile clears it. Never called for Connecting. */
  setUnreachable: (reason: string) => void;
}

/** mEdit runs for the extension's whole lifetime, so a status change is news the views report,
 *  never a mode they switch into (ADR-0002). Returns the unsubscribe. */
export function wireBackendStatus(client: StatusSource, views: BackendStatusViews): () => void {
  return client.onStatusChanged((status) => {
    views.setStatusText(backendStatusText(status));
    // A backend on its way up owns the views itself: the launch armed its reconcile before
    // asking the client to start, and the reconcile is what hands the tree its load order.
    if (status === 'starting' || status === 'attached') return;
    views.abandonReconcile();
    views.refreshTree();
    views.setUnreachable(UNREACHABLE_REASON[status]);
  });
}

/** A crash-restart is a fresh backend holding no load order, so the reconcile runs again from
 *  scratch — the same re-entry path a fresh launch takes, not a bespoke recovery. */
export function enterEditingAcrossRestarts(
  client: StatusSource, enterEditing: () => Promise<void>, log: (msg: string) => void,
): { enter: () => Promise<void>; dispose: () => void } {
  // A `disconnected` nobody asked for is the crash; the `attached` after it is the fresh
  // process. Cleared by every deliberate entry, so a relaunch is not also read as a restart.
  let crashed = false;
  const enter = () => { crashed = false; return enterEditing(); };
  const unsubscribe = client.onStatusChanged((status) => {
    if (status === 'disconnected') { crashed = true; return; }
    if (status !== 'attached' || !crashed) return;
    void enter().catch((err: unknown) =>
      log(`reload after backend restart failed: ${errorMessage(err)}`),
    );
  });
  return { enter, dispose: unsubscribe };
}
