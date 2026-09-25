import type * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';

export type FollowedPanel = { title: string; webview: Pick<vscode.Webview, 'postMessage'> };

interface FormKeyTracker<Panel> {
  formKeyOf(panel: Panel): string | undefined;
  setFormKey(panel: Panel, formKey: string): void;
}

/** Where an edit is addressed: the record, and the plugin copy whose column it was made in
 *  (ADR-0012). */
export interface EditAddress { formKey: string; plugin: string; origin: string }

/** One edit a panel makes: the write, sent to the FormKey the record is at now. */
export type EditGate = (address: EditAddress, write: (formKey: string) => Promise<string | undefined>) => Promise<void>;

interface InFlight { writes: number; reported: Set<string>; refreshed: boolean }

// One plugin copy's record moved by an edit of its FormID. `readAt` is when the tab read `to`: an
// address taken after it names what it means.
interface Move { plugin: string; origin: string; from: string; to: string; readAt: number | undefined }

/** A panel with an edit in flight reads again once, after the answer, under the FormKey it then
 *  shows, and only on mEdit's report of the change, which may land first (editor.md, States 5). */
export class EditsInFlight<Panel extends FollowedPanel> {
  private readonly inFlight = new Map<Panel, InFlight>();
  private readonly moves = new Map<Panel, Move[]>();
  private clock = 0;

  constructor(private readonly tracker: FormKeyTracker<Panel>) {}

  /** The panel's gate for edits addressed from now on. */
  gate(panel: Panel): EditGate {
    const addressedAt = ++this.clock;
    return (address, write) => this.edit(panel, address, addressedAt, write);
  }

  /** The notification wiring's gate: true holds the panel's read, keeping the keys reported. */
  holds(panel: Panel, keys: readonly string[]): boolean {
    const entry = this.inFlight.get(panel);
    if (entry) {
      for (const key of keys) entry.reported.add(key);
      return true;
    }
    const shown = this.tracker.formKeyOf(panel);
    if (shown && keys.includes(shown)) this.markRead(panel, shown);
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

  /** The FormKey a panel waits on a report for, when no edit of it is in flight. */
  waitingFor(panel: Panel): string | undefined {
    return this.inFlight.has(panel) || !this.awaitsRead(panel) ? undefined : this.tracker.formKeyOf(panel);
  }

  /** True when the panel still waited on `formKey`, which it now reads, marked read. */
  release(panel: Panel, formKey: string): boolean {
    if (this.waitingFor(panel) !== formKey) return false;
    this.markRead(panel, formKey);
    return true;
  }

  /** A closed panel: nothing of it is held any longer. */
  forget(panel: Panel): void {
    this.inFlight.delete(panel);
    this.moves.delete(panel);
  }

  private async edit(
    panel: Panel, address: EditAddress, addressedAt: number, write: (formKey: string) => Promise<string | undefined>,
  ): Promise<void> {
    const target = { ...address, formKey: this.targetOf(panel, address, addressedAt) };
    const entry = this.inFlight.get(panel) ?? { writes: 0, reported: new Set<string>(), refreshed: false };
    entry.writes += 1;
    this.inFlight.set(panel, entry);
    let newFormKey: string | undefined;
    try {
      newFormKey = await write(target.formKey);
    } finally {
      entry.writes -= 1;
      if (entry.writes === 0) this.inFlight.delete(panel);
    }
    if (newFormKey) this.follow(panel, target, newFormKey);
    if (entry.writes === 0) this.settle(panel, entry);
  }

  // An edit of the FormID moves its own plugin copy's record, and the tab goes with it (editor.md,
  // The FormID).
  private follow(panel: Panel, target: EditAddress, newFormKey: string): void {
    const moves = this.moves.get(panel) ?? [];
    moves.push({ plugin: target.plugin, origin: target.origin, from: target.formKey, to: newFormKey, readAt: undefined });
    this.moves.set(panel, moves);
    if (this.tracker.formKeyOf(panel) !== target.formKey) return;
    this.tracker.setFormKey(panel, newFormKey);
    if (panel.title === target.formKey) panel.title = newFormKey;
  }

  // The last answer in: what the held reports and refreshes asked for, once.
  private settle(panel: Panel, entry: InFlight): void {
    const shown = this.tracker.formKeyOf(panel);
    if (shown && entry.reported.has(shown)) {
      this.markRead(panel, shown);
      this.post(panel, { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: shown });
    } else if (entry.refreshed && !this.awaitsRead(panel)) {
      this.post(panel, { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED });
    }
  }

  private awaitsRead(panel: Panel): boolean {
    const shown = this.tracker.formKeyOf(panel);
    return (this.moves.get(panel) ?? []).some(move => move.to === shown && move.readAt === undefined);
  }

  // Reading a chain's last key ends every move in it, back to the key the tab last read.
  private markRead(panel: Panel, formKey: string): void {
    const moves = this.moves.get(panel) ?? [];
    const readAt = ++this.clock;
    let ended = moves.filter(move => move.readAt === undefined && move.to === formKey);
    while (ended.length > 0) {
      for (const move of ended) move.readAt = readAt;
      const reached = ended;
      ended = moves.filter(move => move.readAt === undefined && reached.some(later =>
        later.from === move.to && later.plugin === move.plugin && later.origin === move.origin));
    }
  }

  // The same copy's record, addressed before the tab read where it moved to, is where it moved to.
  private targetOf(panel: Panel, address: EditAddress, addressedAt: number): string {
    let formKey = address.formKey;
    for (const move of this.moves.get(panel) ?? []) {
      const sameCopy = move.plugin === address.plugin && move.origin === address.origin;
      if (sameCopy && move.from === formKey && (move.readAt === undefined || addressedAt < move.readAt)) formKey = move.to;
    }
    return formKey;
  }

  private post(panel: Panel, message: ExtensionToWebview): void {
    void panel.webview.postMessage(message);
  }
}
