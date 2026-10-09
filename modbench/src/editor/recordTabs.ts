import * as vscode from 'vscode';
import { RecordTab, type EditAddress, type EditGate, type TabPanel } from './recordTab';
import type { FocusedCellContext } from '../wire/messages';

/** The open record tabs, and the one in focus: its record, which Referenced By follows, and its
 *  focused cell, which a field gesture from the palette acts on. */
export class RecordTabs implements Iterable<RecordTab> {
  private readonly _onDidChangeActiveRecord = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeActiveRecord = this._onDidChangeActiveRecord.event;
  private readonly tabs = new Set<RecordTab>();
  private active: RecordTab | undefined;
  private lastFired: string | undefined;

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
    const tab = new RecordTab(panel, document, {
      retargeted: (moved) => { if (moved === this.active) this.fire(moved.formKey); },
      closed: (closed) => { this.close(closed); },
    });
    this.tabs.add(tab);
    return tab;
  }

  activeRecord(): string | undefined {
    return this.lastFired;
  }

  /** The record tab last in focus; none once it closes. */
  activeTab(): RecordTab | undefined {
    return this.active;
  }

  focusedCell(): FocusedCellContext | undefined {
    return this.active?.cell;
  }

  /** VS Code can report the tab in focus again, which must not force a Referenced By refetch. */
  focus(tab: RecordTab): void {
    if (tab !== this.active) {
      this.active = tab;
      this.fire(tab.formKey);
    }
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

  // VS Code has no "last record tab closed" event. A closing tab in focus with others open keeps
  // its record until another tab gains focus.
  private close(tab: RecordTab): void {
    this.tabs.delete(tab);
    if (tab === this.active) {
      this.active = undefined;
      this.showCell(undefined);
    }
    if (this.lastFired !== undefined && [...this.tabs].every((open) => open.formKey === undefined)) this.fire(undefined);
  }

  private fire(formKey: string | undefined): void {
    this.lastFired = formKey;
    this._onDidChangeActiveRecord.fire(formKey);
  }
}
