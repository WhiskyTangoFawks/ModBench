import * as vscode from 'vscode';
import { RecordTab, type EditAddress, type EditGate, type TabPanel } from './recordTab';
import { EXTENSION_TO_WEBVIEW, type FocusedCellContext } from '../wire/messages';

/** The open record tabs, and the one in focus: its record, which Referenced By from the palette
 *  asks about, and its focused cell, which a field gesture from the palette acts on. */
export class RecordTabs implements Iterable<RecordTab> {
  private readonly tabs = new Set<RecordTab>();
  private active: RecordTab | undefined;
  private collapsingNoConflict = false;

  /** `showCell` hears the in-focus tab's cell whenever it changes. `entered` hears the user take the
   *  focus: a cell clicked, or a tab gaining it. */
  constructor(
    private readonly showCell: (cell: FocusedCellContext | undefined) => void,
    private readonly entered: () => void,
  ) {}

  [Symbol.iterator](): Iterator<RecordTab> {
    return this.tabs.values();
  }

  open(panel: TabPanel, document: vscode.Uri): RecordTab {
    const tab = new RecordTab(panel, document, { closed: (closed) => { this.close(closed); } });
    this.tabs.add(tab);
    if (this.collapsingNoConflict) tab.postOnceListening(this.noConflictMessage(false));
    return tab;
  }

  collapseNoConflict(collapse: boolean): void {
    this.collapsingNoConflict = collapse;
    for (const tab of this.tabs) tab.postOnceListening(this.noConflictMessage(true));
  }

  /** The record tab last in focus; none once it closes. */
  activeTab(): RecordTab | undefined {
    return this.active;
  }

  focusedCell(): FocusedCellContext | undefined {
    return this.active?.cell;
  }

  focus(tab: RecordTab): void {
    this.active = tab;
    this.showCell(tab.cell);
    this.entered();
  }

  setCell(tab: RecordTab, cell: FocusedCellContext | undefined, userFocus: boolean): void {
    tab.focusCell(cell);
    if (tab === this.active) this.showCell(cell);
    if (userFocus) this.entered();
  }

  /** The gate of every tab showing the record `address` names, as of now: one write, held and
   *  followed by each. */
  gateShowing(address: EditAddress): EditGate {
    const gates = [...this.tabs].flatMap((tab) => tab.gateShowing(address) ?? []);
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

  private noConflictMessage(again: boolean) {
    return { type: EXTENSION_TO_WEBVIEW.COLLAPSE_NO_CONFLICT, on: this.collapsingNoConflict, again } as const;
  }

  private close(tab: RecordTab): void {
    this.tabs.delete(tab);
    if (tab === this.active) {
      this.active = undefined;
      this.showCell(undefined);
    }
  }
}
