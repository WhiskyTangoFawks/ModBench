import type * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';

export type FollowedPanel = { title: string; webview: Pick<vscode.Webview, 'postMessage'> };

interface FormKeyTracker<Panel> {
  formKeyOf(panel: Panel): string | undefined;
  setFormKey(panel: Panel, formKey: string): void;
}

/** A panel with an edit in flight reads again once, after the answer, under the FormKey it then
 *  shows, and only on mEdit's report of the change, which may land first (editor.md, States 5). */
export class EditsInFlight<Panel extends FollowedPanel> {
  private readonly inFlight = new Map<Panel, { writes: number; reported: Set<string> }>();

  constructor(private readonly tracker: FormKeyTracker<Panel>) {}

  /** The notification wiring's gate: true holds the panel's read, keeping the keys reported. */
  holds(panel: Panel, keys: readonly string[]): boolean {
    const entry = this.inFlight.get(panel);
    if (!entry) return false;
    for (const key of keys) entry.reported.add(key);
    return true;
  }

  async edit(panel: Panel, formKey: string, write: () => Promise<string | undefined>): Promise<void> {
    const entry = this.inFlight.get(panel) ?? { writes: 0, reported: new Set<string>() };
    entry.writes += 1;
    this.inFlight.set(panel, entry);
    let newFormKey: string | undefined;
    try {
      newFormKey = await write();
    } finally {
      entry.writes -= 1;
      if (entry.writes === 0) this.inFlight.delete(panel);
    }

    // An edit of the FormID takes the tab with the record (editor.md, The FormID).
    if (newFormKey && this.tracker.formKeyOf(panel) === formKey) {
      this.tracker.setFormKey(panel, newFormKey);
      if (panel.title === formKey) panel.title = newFormKey;
    }
    const shown = this.tracker.formKeyOf(panel);
    if (entry.writes === 0 && shown && entry.reported.has(shown)) {
      void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: shown } satisfies ExtensionToWebview);
    }
  }
}
