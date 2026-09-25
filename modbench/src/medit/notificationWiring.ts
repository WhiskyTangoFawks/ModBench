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

// One FormKey spans its whole override chain, so matching it alone is enough — no plugin/origin
// check. A plugin read again whole names no rows, so every panel reads again. LOAD_RECORD already
// re-reads unconditionally, even for an already-shown FormKey. `activeRecordTracker` and `Panel`
// are both structural — Editor's own types unnamed here.
export function subscribeRecordPanelsToNotifications<Panel extends { webview: Pick<vscode.Webview, 'postMessage'> }>(
  client: Pick<MEditClient, 'subscribe'>,
  recordPanels: Set<Panel>,
  activeRecordTracker: { formKeyOf(panel: Panel): string | undefined },
): () => void {
  const reread = (shows: (formKey: string) => boolean) => {
    for (const panel of recordPanels) {
      const formKey = activeRecordTracker.formKeyOf(panel);
      if (formKey && shows(formKey)) {
        void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
      }
    }
  };
  const unsubscribeRows = client.subscribe('rows-changed', (event) => reread(formKey => event.keys.includes(formKey)));
  const unsubscribePlugin = client.subscribe('plugin-changed', () => reread(() => true));
  return () => { unsubscribeRows(); unsubscribePlugin(); };
}
