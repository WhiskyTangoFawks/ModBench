import { isKeyArgs } from '../drivingLib/copyValue';

/** A record tab's focused cell, as the context its right-click menu hands a command. */
export type FocusedCellContext = object;

function focusedCellKeys(cell: FocusedCellContext | undefined): Record<string, unknown> {
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
