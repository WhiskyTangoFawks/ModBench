import type * as vscode from 'vscode';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';
import { pluginAddressOf, samePluginAddress } from '../wire/pluginAddress';

export type FollowedPanel = { title: string; webview: Pick<vscode.Webview, 'postMessage'> };

interface FormKeyTracker<Panel> {
  formKeyOf(panel: Panel): string | undefined;
  setFormKey(panel: Panel, formKey: string): void;
}

/** Where an edit is addressed: the record, and the plugin whose column it was made in
 *  (ADR-0012). */
export interface EditAddress { formKey: string; plugin: string; origin: string }

/** One edit a panel makes: the write, sent to the FormKey the record is at now. */
export type EditGate = (address: EditAddress, write: (formKey: string) => Promise<string | undefined>) => Promise<void>;

interface InFlight { writes: number; reported: Set<string>; refreshed: boolean }

// One plugin's record moved by an edit of its FormID. `asked` is whether the tab was told to read
// `to`. `readAt` is when that read was answered: an address taken after it names what it means.
interface Move { plugin: string; origin: string; from: string; to: string; asked: boolean; readAt: number | undefined }

/** The one place a record tab reads again. With an edit in flight, it reads once after the
 *  answer, under the FormKey it then shows, and only on mEdit's report, which may land first
 *  (editor.md, States, story 5). */
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

  /** The gate of every panel showing the record `address` names, as of now: one write, held and
   *  followed by each. A panel that moved the record shows it under the key it moved to. */
  gateShowing(panels: Iterable<Panel>, address: EditAddress): EditGate {
    const gates = [...panels].flatMap(panel => {
      const gate = this.gate(panel);
      return this.tracker.formKeyOf(panel) === this.targetOf(panel, address, this.clock) ? [gate] : [];
    });
    const through = async (
      index: number, address: EditAddress, key: string, write: (formKey: string) => Promise<string | undefined>,
    ): Promise<string | undefined> => {
      const gate = gates[index];
      if (!gate) return write(key);
      let answer: string | undefined;
      await gate(address, async target => { answer = await through(index + 1, address, target, write); return answer; });
      return answer;
    };
    return async (address, write) => { await through(0, address, address.formKey, write); };
  }

  /** mEdit reported `keys` changed: the panel reads again when it shows one of them, unless an edit
   *  of it is in flight, which keeps the keys for its answer. A FormKey spans its override chain, so
   *  matching it is enough. */
  reported(panel: Panel, keys: readonly string[]): void {
    const entry = this.inFlight.get(panel);
    if (entry) {
      for (const key of keys) entry.reported.add(key);
      return;
    }
    const shown = this.tracker.formKeyOf(panel);
    if (!shown || !keys.includes(shown)) return;
    for (const move of this.moves.get(panel) ?? []) if (move.to === shown) move.asked = true;
    this.read(panel, shown);
  }

  /** The comparison may have changed: the panel reads again, unless it waits on the answer or on
   *  the report that reads the record's new FormKey. */
  refresh(panel: Panel): void {
    const entry = this.inFlight.get(panel);
    if (entry) {
      entry.refreshed = true;
      return;
    }
    const shown = this.tracker.formKeyOf(panel);
    if (shown && !this.awaitsReport(panel)) this.read(panel, shown);
  }

  /** The FormKey a panel waits on a report for, when no edit of it is in flight. */
  waitingFor(panel: Panel): string | undefined {
    return this.inFlight.has(panel) || !this.awaitsReport(panel) ? undefined : this.tracker.formKeyOf(panel);
  }

  /** mEdit holds `formKey`: the panel reads it if it still waits on it. */
  release(panel: Panel, formKey: string): void {
    if (this.waitingFor(panel) === formKey) this.reported(panel, [formKey]);
  }

  /** The tab's read of `formKey` is answered: it shows that record from now on. Reading a chain's
   *  last key ends every move in it, back to the key the tab last read. */
  answered(panel: Panel, formKey: string): void {
    const moves = this.moves.get(panel) ?? [];
    const readAt = ++this.clock;
    let ended = moves.filter(move => move.readAt === undefined && move.to === formKey);
    while (ended.length > 0) {
      for (const move of ended) move.readAt = readAt;
      const reached = ended;
      ended = moves.filter(move => move.readAt === undefined && reached.some(later =>
        later.from === move.to && samePluginAddress(pluginAddressOf(later), pluginAddressOf(move))));
    }
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

  // An edit of the FormID moves its own plugin's record, and the tab goes with it (editor.md,
  // The record header, story 2).
  private follow(panel: Panel, target: EditAddress, newFormKey: string): void {
    const moves = this.moves.get(panel) ?? [];
    moves.push({ plugin: target.plugin, origin: target.origin, from: target.formKey, to: newFormKey, asked: false, readAt: undefined });
    this.moves.set(panel, moves);
    if (this.tracker.formKeyOf(panel) !== target.formKey) return;
    this.tracker.setFormKey(panel, newFormKey);
    if (panel.title === target.formKey) panel.title = newFormKey;
  }

  // The last answer in: what the held reports and refreshes asked for, once.
  private settle(panel: Panel, entry: InFlight): void {
    const shown = this.tracker.formKeyOf(panel);
    if (shown && entry.reported.has(shown)) this.reported(panel, [shown]);
    else if (entry.refreshed) this.refresh(panel);
  }

  private awaitsReport(panel: Panel): boolean {
    const shown = this.tracker.formKeyOf(panel);
    return (this.moves.get(panel) ?? []).some(move => move.to === shown && !move.asked);
  }

  // The same plugin's record, addressed before the tab read where it moved to, is where it
  // moved to.
  private targetOf(panel: Panel, address: EditAddress, addressedAt: number): string {
    let formKey = address.formKey;
    for (const move of this.moves.get(panel) ?? []) {
      const samePlugin = samePluginAddress(pluginAddressOf(move), pluginAddressOf(address));
      if (samePlugin && move.from === formKey && (move.readAt === undefined || addressedAt < move.readAt)) formKey = move.to;
    }
    return formKey;
  }

  private read(panel: Panel, formKey: string): void {
    void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
  }
}
