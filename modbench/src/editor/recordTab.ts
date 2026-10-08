import type * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, type ColumnCopy, type ExtensionToWebview, type ViewState } from '../wire/messages';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import type { FocusedCellContext } from './focusedCells';

export type TabPanel = Pick<vscode.WebviewPanel, 'title' | 'active' | 'viewColumn' | 'onDidDispose'> & {
  webview: Pick<vscode.Webview, 'postMessage'>;
};

/** Where an edit is addressed: the record, and the plugin whose column it was made in. */
export interface EditAddress { formKey: string; plugin: PluginAddress }

/** One edit a tab makes: the write, sent to the FormKey the record is at now. */
export type EditGate = (address: EditAddress, write: (formKey: string) => Promise<string | undefined>) => Promise<void>;

interface InFlight { writes: number; reported: Set<string>; refreshed: boolean }

interface Move { plugin: PluginAddress; from: string; to: string; toldToRead: boolean; readAnsweredAt: number | undefined }

interface TabEvents { retargeted(tab: RecordTab): void; closed(tab: RecordTab): void }

/** One open record tab, and the one place it reads again: with an edit in flight, a read waits for
 *  the answer, then reads once under the FormKey the tab then shows. Closed, it acts on nothing. */
export class RecordTab {
  private shown: EditAddress | undefined;
  private fileRead: (() => Promise<void>) | undefined;
  private placeKept: ViewState | undefined;
  private focused: FocusedCellContext | undefined;
  private originsRead: readonly string[] = [];
  private columnsRead: readonly ColumnCopy[] = [];
  private inFlight: InFlight | undefined;
  private readonly moves: Move[] = [];
  private clock = 0;
  private open = true;
  private readonly owned: vscode.Disposable[] = [];
  private pageListens: () => void = () => undefined;
  // A tab's page listens once it asks its first read, so a message posted before it is lost.
  private readonly listening = new Promise<void>((listens) => { this.pageListens = listens; });

  constructor(readonly panel: TabPanel, readonly document: vscode.Uri, private readonly events: TabEvents) {
    panel.onDidDispose(() => { this.close(); });
  }

  get isOpen(): boolean { return this.open; }

  /** The copy the tab's document holds, while it is open and shown. */
  get copy(): EditAddress | undefined { return this.open && this.shown ? { ...this.shown } : undefined; }

  get formKey(): string | undefined { return this.copy?.formKey; }

  /** Open, and waiting for mEdit to say which record its file holds. */
  get awaitsRecord(): boolean { return this.open && !this.shown; }

  get place(): ViewState | undefined { return this.placeKept; }

  get cell(): FocusedCellContext | undefined { return this.focused; }

  get origins(): readonly string[] { return this.originsRead; }

  /** The records the tab's last answered read showed beside its own. */
  get columns(): readonly ColumnCopy[] { return this.columnsRead; }

  show({ formKey, plugin }: EditAddress): void {
    this.shown = { formKey, plugin };
  }

  /** Reads which record the tab's file holds, now and again on each `readFileAgain` until it shows one. */
  readFile(read: () => Promise<void>): Promise<void> {
    this.fileRead = read;
    return read();
  }

  readFileAgain(): void {
    if (this.awaitsRecord) void this.fileRead?.();
  }

  keepPlace(place: ViewState): void { this.placeKept = place; }

  focusCell(cell: FocusedCellContext | undefined): void { this.focused = cell; }

  showOrigins(origins: readonly string[]): void { this.originsRead = origins; }

  /** Disposed when the tab closes. */
  own(disposable: vscode.Disposable): void {
    if (this.open) this.owned.push(disposable);
    else disposable.dispose();
  }

  post(message: ExtensionToWebview): void {
    if (this.open) void this.panel.webview.postMessage(message);
  }

  /** The page asked its first read. */
  listens(): void { this.pageListens(); }

  postOnceListening(message: ExtensionToWebview): void {
    void this.listening.then(() => { this.post(message); });
  }

  /** The tab's gate for edits addressed from now on. */
  gate(): EditGate {
    const addressedAt = ++this.clock;
    return (address, write) => this.edit(address, addressedAt, write);
  }

  /** The tab's gate when it shows the record `address` names, as of now. Having moved the record,
   *  it shows it under the key it moved to. */
  gateShowing(address: EditAddress): EditGate | undefined {
    const addressedAt = ++this.clock;
    if (this.formKey !== this.keyNow(address, addressedAt)) return undefined;
    return (edited, write) => this.edit(edited, addressedAt, write);
  }

  /** mEdit reported `keys` changed: the tab reads again when it shows one of them, unless an edit of
   *  it is in flight, which keeps the keys for its answer. A FormKey spans its override chain. */
  reported(keys: readonly string[]): void {
    if (this.inFlight) {
      for (const key of keys) this.inFlight.reported.add(key);
      return;
    }
    const shown = this.formKey;
    if (!shown || !this.shows(shown, keys)) return;
    for (const move of this.moves) if (move.to === shown) move.toldToRead = true;
    this.read(shown);
  }

  /** The comparison may have changed: the tab reads again, unless it waits on the answer or on the
   *  report that reads the record's new FormKey. */
  refresh(): void {
    if (this.inFlight) {
      this.inFlight.refreshed = true;
      return;
    }
    const shown = this.formKey;
    if (shown && !this.awaitsReport()) this.read(shown);
  }

  /** The FormKey the tab waits on a report for, when no edit of it is in flight. */
  waitingFor(): string | undefined {
    return this.inFlight || !this.awaitsReport() ? undefined : this.formKey;
  }

  /** mEdit holds `formKey`: the tab reads it if it still waits on it. */
  release(formKey: string): void {
    if (this.waitingFor() === formKey) this.reported([formKey]);
  }

  /** The tab's read of `formKey` is answered: it shows that record from now on, and `columns`
   *  beside it. Reading a chain's last key ends every move in it, back to the key the tab last read. */
  answered(formKey: string, columns: readonly ColumnCopy[]): void {
    this.columnsRead = columns;
    const answeredAt = ++this.clock;
    let ended = this.moves.filter(move => move.readAnsweredAt === undefined && move.to === formKey);
    while (ended.length > 0) {
      for (const move of ended) move.readAnsweredAt = answeredAt;
      const reached = ended;
      ended = this.moves.filter(move => move.readAnsweredAt === undefined && reached.some(later =>
        later.from === move.to && samePluginAddress(later.plugin, move.plugin)));
    }
  }

  /** An edit moved the plugin's record from `from` to `to`, which the tab shows: it reads `to` once
   *  mEdit reports it. */
  moved(plugin: PluginAddress, from: string, to: string): void {
    this.moves.push({ plugin, from, to, toldToRead: false, readAnsweredAt: undefined });
  }

  private close(): void {
    this.open = false;
    for (const disposable of this.owned.splice(0)) disposable.dispose();
    this.events.closed(this);
  }

  private async edit(address: EditAddress, addressedAt: number, write: (formKey: string) => Promise<string | undefined>): Promise<void> {
    const target = { ...address, formKey: this.keyNow(address, addressedAt) };
    const entry = this.inFlight ?? { writes: 0, reported: new Set<string>(), refreshed: false };
    entry.writes += 1;
    this.inFlight = entry;
    let newFormKey: string | undefined;
    try {
      newFormKey = await write(target.formKey);
    } finally {
      entry.writes -= 1;
      if (entry.writes === 0) this.inFlight = undefined;
    }
    if (!this.open) return;
    if (newFormKey) this.follow(target, newFormKey);
    if (entry.writes === 0) this.readWhatWasHeld(entry);
  }

  // An edit of the FormID moves its own plugin's record, and the tab goes with it (editor.md,
  // The record header, story 2).
  private follow(target: EditAddress, newFormKey: string): void {
    this.moved(target.plugin, target.formKey, newFormKey);
    if (this.shown?.formKey !== target.formKey) return;
    this.shown = { ...this.shown, formKey: newFormKey };
    if (this.panel.title === target.formKey) this.panel.title = newFormKey;
    this.events.retargeted(this);
  }

  private readWhatWasHeld(entry: InFlight): void {
    const shown = this.formKey;
    if (shown && this.shows(shown, [...entry.reported])) this.reported([...entry.reported]);
    else if (entry.refreshed) this.refresh();
  }

  private shows(shown: string, keys: readonly string[]): boolean {
    return [shown, ...this.columnsRead.map(({ formKey }) => formKey)].some(key => keys.includes(key));
  }

  private awaitsReport(): boolean {
    return this.moves.some(move => move.to === this.formKey && !move.toldToRead);
  }

  private keyNow(address: EditAddress, addressedAt: number): string {
    let formKey = address.formKey;
    for (const move of this.moves) {
      const samePlugin = samePluginAddress(move.plugin, address.plugin);
      const addressedBeforeItsRead = move.readAnsweredAt === undefined || addressedAt < move.readAnsweredAt;
      if (samePlugin && move.from === formKey && addressedBeforeItsRead) formKey = move.to;
    }
    return formKey;
  }

  private read(formKey: string): void {
    this.post({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey });
  }
}
