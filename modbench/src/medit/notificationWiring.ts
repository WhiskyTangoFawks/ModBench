import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';

// Any reconcile-free record change is reason enough for a whole refresh() — the tree has no
// per-row identity to check against the event (ADR-0015 invariant 3).
export function subscribeTreeToNotifications(
  client: Pick<MEditClient, 'subscribe'>, tree: { refresh(): void },
): () => void {
  const unsubscribeRows = client.subscribe('rows-changed', () => tree.refresh());
  const unsubscribePlugin = client.subscribe('plugin-changed', () => tree.refresh());
  return () => { unsubscribeRows(); unsubscribePlugin(); };
}

// A FormKey spans its override chain, so matching it is enough. `heldReads` holds a panel's reads
// until its edit is answered; on reconnect, one waiting on a missed report reads once mEdit holds it.
export function subscribeRecordPanelsToNotifications<Panel extends { webview: Pick<vscode.Webview, 'postMessage'> }>(
  client: Pick<MEditClient, 'subscribe' | 'onReconnected' | 'getRecordOwner'>,
  recordPanels: Set<Panel>,
  activeRecordTracker: { formKeyOf(panel: Panel): string | undefined },
  heldReads: {
    holds(panel: Panel, keys: readonly string[]): boolean;
    waitingFor(panel: Panel): string | undefined;
    release(panel: Panel, formKey: string): boolean;
  },
): () => void {
  const read = (panel: Panel, formKey: string) => {
    void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
  };
  const unsubscribeRows = client.subscribe('rows-changed', (event) => {
    for (const panel of recordPanels) {
      if (heldReads.holds(panel, event.keys)) continue;
      const formKey = activeRecordTracker.formKeyOf(panel);
      if (formKey && event.keys.includes(formKey)) read(panel, formKey);
    }
  });
  const unsubscribeReconnect = client.onReconnected(() => {
    for (const panel of recordPanels) {
      const formKey = heldReads.waitingFor(panel);
      if (!formKey) continue;
      // A failed ask leaves the panel waiting, as a missing key does: the report still reads it.
      client.getRecordOwner(formKey).then(
        owner => { if (owner && heldReads.release(panel, formKey)) read(panel, formKey); },
        () => undefined);
    }
  });
  return () => { unsubscribeRows(); unsubscribeReconnect(); };
}

/** A completed reconcile or a landed Track: every record panel refreshes its comparison, except
 *  one whose read `heldReads` holds, which refreshes when its hold ends. */
export function announceConflictsComputed<Panel extends { webview: Pick<vscode.Webview, 'postMessage'> }>(
  recordPanels: Set<Panel>,
  heldReads: { holdsRefresh(panel: Panel): boolean },
): void {
  for (const panel of recordPanels) {
    if (heldReads.holdsRefresh(panel)) continue;
    void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED } satisfies ExtensionToWebview);
  }
}
