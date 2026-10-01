/** A record tab's focused cell, as the context its right-click menu hands a command. */
export type FocusedCellContext = object;

/** The focused cell of each open record tab, and of the one in focus: what a field gesture from
 *  the palette acts on. `show` hears the in-focus tab's cell whenever it changes. */
export class FocusedCells<TPanel> {
  private readonly cells = new Map<TPanel, FocusedCellContext>();
  private active: TPanel | undefined;

  /** `entered` hears the user take the focus: a cell clicked, or the panel gaining it. */
  constructor(
    private readonly show: (cell: FocusedCellContext | undefined) => void,
    private readonly entered: () => void,
  ) {}

  current(): FocusedCellContext | undefined {
    return this.active === undefined ? undefined : this.cells.get(this.active);
  }

  setCell(panel: TPanel, cell: FocusedCellContext | undefined, userFocus = false): void {
    if (cell === undefined) this.cells.delete(panel);
    else this.cells.set(panel, cell);
    if (panel === this.active) this.show(cell);
    if (userFocus) this.entered();
  }

  /** The cell the panel in focus reports; nothing while no panel is. */
  setActiveCell(cell: FocusedCellContext | undefined): void {
    if (this.active !== undefined) this.setCell(this.active, cell);
  }

  setActivePanel(panel: TPanel): void {
    this.active = panel;
    this.show(this.current());
    this.entered();
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

/** What a copy value key or the palette names as the record grid, as `focusedView` names a list. */
export const GRID_VIEW = 'modbench.recordGrid';

/** The grid's text for the catalog's copy value: the cell the webview's Ctrl+C names, or, from the
 *  palette with the grid focused, the focused cell of the record tab in focus. */
export function gridCopyValueText(
  focusedCell: () => FocusedCellContext | undefined,
): (invocation: unknown) => string | undefined {
  const textOf = (cell: unknown): string | undefined => {
    const text: unknown = typeof cell === 'object' && cell !== null ? Reflect.get(cell, 'copyText') : undefined;
    return typeof text === 'string' ? text : undefined;
  };
  return (invocation) => {
    const fromGridKey = typeof invocation === 'object' && invocation !== null && Reflect.get(invocation, 'view') === GRID_VIEW;
    return textOf(fromGridKey ? focusedCell() : invocation);
  };
}
