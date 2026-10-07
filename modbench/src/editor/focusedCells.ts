import { isKeyArgs } from '../drivingLib/copyValue';

/** A record tab's focused cell, as the context its right-click menu hands a command. */
export type FocusedCellContext = object;

/** The focused cell of each open record tab, and of the one in focus: what a field gesture from
 *  the palette acts on. `show` hears the in-focus tab's cell whenever it changes. */
export class FocusedCells<TPanel> {
  private readonly cells = new Map<TPanel, FocusedCellContext>();

  /** `activePanel` is the record tab in focus, which the caller owns. `entered` hears the user
   *  take the focus: a cell clicked, or the panel gaining it. */
  constructor(
    private readonly activePanel: () => TPanel | undefined,
    private readonly show: (cell: FocusedCellContext | undefined) => void,
    private readonly entered: () => void,
  ) {}

  current(): FocusedCellContext | undefined {
    const active = this.activePanel();
    return active === undefined ? undefined : this.cells.get(active);
  }

  setCell(panel: TPanel, cell: FocusedCellContext | undefined, userFocus = false): void {
    if (cell === undefined) this.cells.delete(panel);
    else this.cells.set(panel, cell);
    if (panel === this.activePanel()) this.show(cell);
    if (userFocus) this.entered();
  }

  /** The caller has made a panel the one in focus. */
  panelFocused(): void {
    this.show(this.current());
    this.entered();
  }

  /** Called while the panel is still the one in focus, so its cell is shown away. */
  removePanel(panel: TPanel): void {
    const wasActive = panel === this.activePanel();
    this.cells.delete(panel);
    if (wasActive) this.show(undefined);
  }
}

/** The keys the field gestures' palette entries and the grid's keys read, named under
 *  `modbench.record.`. */
export function focusedCellKeys(cell: FocusedCellContext | undefined): Record<string, unknown> {
  const field = (name: string): unknown => (cell === undefined ? undefined : Reflect.get(cell, name));
  const section = field('webviewSection');
  const copyText = field('copyText');
  return {
    focusedCellSection: typeof section === 'string' ? section : undefined,
    focusedCellCanMoveUp: field('canMoveUp') === true,
    focusedCellCanMoveDown: field('canMoveDown') === true,
    focusedCellCopies: typeof copyText === 'string' && copyText !== '',
    focusedCellEditorOpen: field('editorOpen') === true,
  };
}

export function publishFocusedCell(
  cell: FocusedCellContext | undefined, setContext: (key: string, value: unknown) => void,
): void {
  Object.entries(focusedCellKeys(cell)).forEach(([name, value]) => { setContext(`modbench.record.${name}`, value); });
}

/** What a copy value key or the palette names as the record grid, as `focusedView` names a list. */
export const GRID_VIEW = 'modbench.recordGrid';

/** The grid's text for the catalog's copy value: the cell a right-click names, or, from Ctrl+C or
 *  the palette with the grid focused, the focused cell of the record tab in focus. */
export function gridCopyValueText(
  focusedCell: () => FocusedCellContext | undefined,
): (invocation: unknown) => string | undefined {
  const textOf = (cell: unknown): string | undefined => {
    const text: unknown = typeof cell === 'object' && cell !== null ? Reflect.get(cell, 'copyText') : undefined;
    return typeof text === 'string' ? text : undefined;
  };
  return (invocation) => {
    return textOf(isKeyArgs(invocation, GRID_VIEW) ? focusedCell() : invocation);
  };
}
