import { isKeyArgs } from '../drivingLib/copyValue';
import { isFocusedCellContext, type FocusedCellContext } from '../wire/messages';

function focusedCellKeys(cell: FocusedCellContext | undefined): Record<string, unknown> {
  return {
    focusedCellSection: cell?.webviewSection,
    focusedCellCanMoveUp: cell?.canMoveUp === true,
    focusedCellCanMoveDown: cell?.canMoveDown === true,
    focusedCellCopies: cell?.copyText !== undefined && cell.copyText !== '',
    focusedCellEditorOpen: cell?.editorOpen === true,
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
  return (invocation) => {
    const cell = isKeyArgs(invocation, GRID_VIEW) ? focusedCell() : invocation;
    return isFocusedCellContext(cell) ? cell.copyText : undefined;
  };
}
