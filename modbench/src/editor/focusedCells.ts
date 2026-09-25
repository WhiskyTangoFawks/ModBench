/** A record tab's focused cell, as the context its right-click menu hands a command. */
export type FocusedCellContext = object;

/** The focused cell of each open record tab, and of the one in focus: what a field gesture from
 *  the palette acts on. `show` hears the in-focus tab's cell whenever it changes. */
export class FocusedCells<TPanel> {
  private readonly cells = new Map<TPanel, FocusedCellContext>();
  private active: TPanel | undefined;

  constructor(private readonly show: (cell: FocusedCellContext | undefined) => void) {}

  current(): FocusedCellContext | undefined {
    return this.active === undefined ? undefined : this.cells.get(this.active);
  }

  setCell(panel: TPanel, cell: FocusedCellContext | undefined): void {
    if (cell === undefined) this.cells.delete(panel);
    else this.cells.set(panel, cell);
    if (panel === this.active) this.show(cell);
  }

  /** The cell the panel in focus reports; nothing while no panel is. */
  setActiveCell(cell: FocusedCellContext | undefined): void {
    if (this.active !== undefined) this.setCell(this.active, cell);
  }

  setActivePanel(panel: TPanel): void {
    this.active = panel;
    this.show(this.current());
  }

  removePanel(panel: TPanel): void {
    this.cells.delete(panel);
    if (panel !== this.active) return;
    this.active = undefined;
    this.show(undefined);
  }
}

/** The keys the field gestures' palette entries read, named under `modbench.record.`. */
export function focusedCellKeys(cell: FocusedCellContext | undefined): Record<string, unknown> {
  const field = (name: string): unknown => (cell === undefined ? undefined : Reflect.get(cell, name));
  const section = field('webviewSection');
  return {
    focusedCellSection: typeof section === 'string' ? section : undefined,
    focusedCellCanMoveUp: field('canMoveUp') === true,
    focusedCellCanMoveDown: field('canMoveDown') === true,
  };
}
