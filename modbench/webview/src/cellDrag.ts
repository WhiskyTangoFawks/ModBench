// What the cell being dragged holds. The panel's own state, so a drag begun anywhere else (another
// panel, another app) is never one a cell here accepts.
export interface CellDrag {
  row: string;
  // The row of the array this cell is an element of; null for a cell that is not an element.
  arrayRow: string | null;
  value: unknown;
}

let dragged: CellDrag | null = null;

export const beginDrag = (drag: CellDrag): void => { dragged = drag; };
export const endDrag = (): void => { dragged = null; };
export const currentDrag = (): CellDrag | null => dragged;
