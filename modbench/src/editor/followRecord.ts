import type * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';

export type FollowedPanel = { title: string; webview: Pick<vscode.Webview, 'postMessage'> };

interface FormKeyTracker<Panel> {
  formKeyOf(panel: Panel): string | undefined;
  setFormKey(panel: Panel, formKey: string): void;
}

/** One edit a panel makes: the write, sent to the FormKey the record is at now. */
export type EditGate = (formKey: string, write: (formKey: string) => Promise<string | undefined>) => Promise<void>;

interface InFlight { writes: number; reported: Set<string>; refreshed: boolean }

/** A panel with an edit in flight reads again once, after the answer, under the FormKey it then
 *  shows, and only on mEdit's report of the change, which may land first (editor.md, States 5). */
export class EditsInFlight<Panel extends FollowedPanel> {
  private readonly inFlight = new Map<Panel, InFlight>();
  // A panel whose record's FormID changed: the webview names `from` until it reads `to`.
  private readonly moved = new Map<Panel, { from: string; to: string; read: boolean }>();

  constructor(private readonly tracker: FormKeyTracker<Panel>) {}

  /** The notification wiring's gate: true holds the panel's read, keeping the keys reported. */
  holds(panel: Panel, keys: readonly string[]): boolean {
    const entry = this.inFlight.get(panel);
    if (entry) {
      for (const key of keys) entry.reported.add(key);
      return true;
    }
    const move = this.moved.get(panel);
    if (move && keys.includes(move.to)) move.read = true;
    return false;
  }

  /** True holds a refresh of the panel's comparison: one waits on the answer, and one waits on the
   *  report that reads the record's new FormKey. */
  holdsRefresh(panel: Panel): boolean {
    const entry = this.inFlight.get(panel);
    if (entry) {
      entry.refreshed = true;
      return true;
    }
    return this.awaitsRead(panel);
  }

  async edit(panel: Panel, formKey: string, write: (formKey: string) => Promise<string | undefined>): Promise<void> {
    const target = this.targetOf(panel, formKey);
    const entry = this.inFlight.get(panel) ?? { writes: 0, reported: new Set<string>(), refreshed: false };
    entry.writes += 1;
    this.inFlight.set(panel, entry);
    let newFormKey: string | undefined;
    try {
      newFormKey = await write(target);
    } finally {
      entry.writes -= 1;
      if (entry.writes === 0) this.inFlight.delete(panel);
    }
    if (newFormKey) this.follow(panel, target, newFormKey);
    if (entry.writes === 0) this.settle(panel, entry);
  }

  // An edit of the FormID takes the tab with the record (editor.md, The FormID).
  private follow(panel: Panel, formKey: string, newFormKey: string): void {
    if (this.tracker.formKeyOf(panel) !== formKey) return;
    this.tracker.setFormKey(panel, newFormKey);
    if (panel.title === formKey) panel.title = newFormKey;
    const previous = this.moved.get(panel);
    const named = previous && !previous.read && previous.to === formKey ? previous.from : formKey;
    this.moved.set(panel, { from: named, to: newFormKey, read: false });
  }

  // The last answer in: what the held reports and refreshes asked for, once.
  private settle(panel: Panel, entry: InFlight): void {
    const shown = this.tracker.formKeyOf(panel);
    if (shown && entry.reported.has(shown)) {
      const move = this.moved.get(panel);
      if (move?.to === shown) move.read = true;
      this.post(panel, { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: shown });
    } else if (entry.refreshed && !this.awaitsRead(panel)) {
      this.post(panel, { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED });
    }
  }

  private awaitsRead(panel: Panel): boolean {
    const move = this.moved.get(panel);
    return move !== undefined && !move.read && this.tracker.formKeyOf(panel) === move.to;
  }

  // The webview names the old FormKey until it reads the new one.
  private targetOf(panel: Panel, formKey: string): string {
    const move = this.moved.get(panel);
    return move && formKey === move.from && this.tracker.formKeyOf(panel) === move.to ? move.to : formKey;
  }

  private post(panel: Panel, message: ExtensionToWebview): void {
    void panel.webview.postMessage(message);
  }
}
