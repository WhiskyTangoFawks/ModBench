import { useCallback, useMemo, useState } from 'react';
import type { ColumnKey, PathHop } from './types';

// The delay every Modbench view waits before it marks a write.
const MARK_DELAY_MS = 300;

/** A value the panel shows in a cell between the write and the read that covers it
 *  (common.md, Unconfirmed writes). */
export interface CellWrite {
  readonly cell: string;
  readonly column: ColumnKey;
  readonly value: unknown;
  /** The grid row the panel wrote it from. A write from elsewhere names only the path. */
  readonly row: string | undefined;
  /** Reads asked for before the write, none of which can cover it. */
  readonly readsAsked: number;
  readonly marked: boolean;
  readonly covered: boolean;
}

export interface CellWrites {
  at: (column: ColumnKey, path: readonly PathHop[], row: string) => CellWrite | undefined;
  /** The covered write goes, with the Output line its cell gives when the disk shows something
   *  else. */
  settle: (cell: string, line: string | undefined) => void;
}

const cellOf = (column: ColumnKey, path: readonly PathHop[]): string => JSON.stringify([column, path]);

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function replaced(writes: ReadonlyMap<string, CellWrite>, write: CellWrite): ReadonlyMap<string, CellWrite> {
  return new Map(writes).set(write.cell, write);
}

function without(writes: ReadonlyMap<string, CellWrite>, cell: string): ReadonlyMap<string, CellWrite> {
  const next = new Map(writes);
  next.delete(cell);
  return next;
}

export function useCellWrites(log: (line: string) => void) {
  const [held, setHeld] = useState<ReadonlyMap<string, CellWrite>>(new Map());

  const written = useCallback((
    column: ColumnKey, path: readonly PathHop[], value: unknown, readsAsked: number, row?: string,
  ) => {
    const cell = cellOf(column, path);
    const write: CellWrite = { cell, column, value, row, readsAsked, marked: false, covered: false };
    setHeld(writes => {
      const now = writes.get(cell);
      return now && !now.covered && sameValue(now.value, value) ? writes : replaced(writes, write);
    });
    setTimeout(() => {
      setHeld(writes => (writes.get(cell) === write ? replaced(writes, { ...write, marked: true }) : writes));
    }, MARK_DELAY_MS);
  }, []);

  const refused = useCallback((column: ColumnKey, path: readonly PathHop[], value: unknown) => {
    const cell = cellOf(column, path);
    setHeld(writes => {
      const now = writes.get(cell);
      return now && sameValue(now.value, value) ? without(writes, cell) : writes;
    });
  }, []);

  /** A read the disk answered covers every write asked for before it, in a column mEdit could
   *  read. */
  const landed = useCallback((read: number, readable: (column: ColumnKey) => boolean) => {
    setHeld(writes => {
      const next = new Map(writes);
      for (const write of writes.values()) {
        if (!write.covered && write.readsAsked < read && readable(write.column)) {
          next.set(write.cell, { ...write, covered: true });
        }
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => { setHeld(new Map()); }, []);

  const settle = useCallback((cell: string, line: string | undefined) => {
    if (line !== undefined) log(line);
    setHeld(writes => without(writes, cell));
  }, [log]);

  const writes = useMemo((): CellWrites => ({
    at: (column, path, row) => {
      const write = held.get(cellOf(column, path));
      return write && (write.row ?? row) === row ? write : undefined;
    },
    settle,
  }), [held, settle]);

  return { writes, written, refused, landed, clear };
}
