import type * as vscode from 'vscode';
import type { MEditClient } from './client';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from './messages';

// Any reconcile-free record change is reason enough for a whole refresh() — the tree has no
// per-row identity to check against the event (ADR-0046 invariant 5).
export function subscribeTreeToNotifications(
  client: Pick<MEditClient, 'subscribe'>, tree: { refresh(): void },
): () => void {
  const unsubscribeRows = client.subscribe('rows-changed', () => tree.refresh());
  const unsubscribePlugin = client.subscribe('plugin-changed', () => tree.refresh());
  return () => { unsubscribeRows(); unsubscribePlugin(); };
}

// One FormKey spans its whole override chain, so matching it alone is enough — no plugin/origin
// check. LOAD_RECORD already re-reads unconditionally, even for an already-shown FormKey.
// `activeRecordTracker` is structural, Editor's own type unnamed here.
export function subscribeRecordPanelsToNotifications(
  client: Pick<MEditClient, 'subscribe'>,
  recordPanels: Set<vscode.WebviewPanel>,
  activeRecordTracker: { formKeyOf(panel: vscode.WebviewPanel): string | undefined },
): () => void {
  return client.subscribe('rows-changed', (event) => {
    for (const panel of recordPanels) {
      const formKey = activeRecordTracker.formKeyOf(panel);
      if (formKey && event.keys.includes(formKey)) {
        void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
      }
    }
  });
}
