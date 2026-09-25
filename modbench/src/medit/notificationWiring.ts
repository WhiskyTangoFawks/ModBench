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

// One FormKey spans its whole override chain, so matching it alone is enough. A panel `heldReads`
// holds reads once its own edit is answered. The tracker, the gate and `Panel` are structural.
export function subscribeRecordPanelsToNotifications<Panel extends { webview: Pick<vscode.Webview, 'postMessage'> }>(
  client: Pick<MEditClient, 'subscribe'>,
  recordPanels: Set<Panel>,
  activeRecordTracker: { formKeyOf(panel: Panel): string | undefined },
  heldReads?: { holds(panel: Panel, keys: readonly string[]): boolean },
): () => void {
  return client.subscribe('rows-changed', (event) => {
    for (const panel of recordPanels) {
      if (heldReads?.holds(panel, event.keys)) continue;
      const formKey = activeRecordTracker.formKeyOf(panel);
      if (formKey && event.keys.includes(formKey)) {
        void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
      }
    }
  });
}
