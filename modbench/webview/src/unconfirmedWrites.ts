import { useCallback, useMemo, useRef, useState } from 'react';
import { columnKey } from './columnKey';
import { displayValue } from './modelValue';
import { defaultOf, recordLabel, variantFor } from './recordUtils';
import type { ColumnKey, CompareResult, FieldDiff, FieldMetadata, PathHop } from './types';

const MARK_DELAY_MS = 300;

/** A value the panel shows in a cell between the write and the read that covers it
 *  (common.md, Unconfirmed writes). */
export interface CellWrite {
  readonly id: number;
  readonly cell: string;
  readonly column: ColumnKey;
  readonly path: readonly PathHop[];
  readonly value: unknown;
  /** Reads asked for before the host held the panel's reads for it, none of which can cover it. */
  readonly readsAsked: number;
  readonly marked: boolean;
}

export type WriteAt = (column: ColumnKey, path: readonly PathHop[]) => CellWrite | undefined;

const cellOf = (column: ColumnKey, path: readonly PathHop[]): string => JSON.stringify([column, path]);

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface DiskCell { label: string; meta: FieldMetadata; value: unknown }

interface Node { diff: FieldDiff | undefined; meta: FieldMetadata | null | undefined }

// One hop down the rows as the grid builds them: an element by index is the row where this column
// holds its element at that place.
function hopDown(diff: FieldDiff, meta: FieldMetadata, hop: PathHop, column: ColumnKey): Node {
  const owner = diff.values[column];
  const children = diff.children ?? [];
  if (hop.kind === 'member') {
    const member = meta.fields?.find(f => f.name === hop.name);
    return { diff: children.find(c => c.fieldName === hop.name), meta: member && variantFor(member, owner, meta) };
  }
  if (hop.kind === 'key') return { diff: children.find(c => c.fieldName === hop.key), meta: meta.elementType };
  return { diff: children.filter(c => c.values[column] != null)[hop.index], meta: meta.elementType };
}

function diskCellAt(result: CompareResult, column: ColumnKey, path: readonly PathHop[]): DiskCell | undefined {
  const [root, ...hops] = path;
  if (root?.kind !== 'member') return undefined;
  let node: Node = {
    diff: result.diffs.find(d => d.fieldName === root.name),
    meta: result.overrides.flatMap(o => o.fields).find(f => f.metadata.name === root.name)?.metadata,
  };
  for (const hop of hops) {
    if (!node.diff || !node.meta) return undefined;
    node = hopDown(node.diff, node.meta, hop, column);
  }
  const { diff, meta } = node;
  if (!diff || !meta) return undefined;
  return { label: meta.displayLabel ?? diff.fieldName, meta, value: diff.values[column] ?? defaultOf(meta) };
}

function differenceLine(result: CompareResult, formKey: string, write: CellWrite): string | undefined {
  const plugin = result.overrides.find(o => columnKey(o.plugin, o.origin) === write.column)?.plugin;
  const disk = plugin === undefined ? undefined : diskCellAt(result, write.column, write.path);
  if (!disk) return undefined;
  const written = displayValue(write.value, disk.meta);
  const shown = displayValue(disk.value, disk.meta);
  return written === shown ? undefined
    : `${disk.label} of ${recordLabel(result.overrides, formKey)} in "${plugin}" was written "${written}", and the disk now shows "${shown}".`;
}

export function useCellWrites(log: (line: string) => void) {
  const [held, setHeld] = useState<ReadonlyMap<string, CellWrite>>(new Map());
  // A callback reads the writes as last changed, which a render may not have caught up with.
  const latest = useRef(held);
  const nextId = useRef(0);
  const change = useCallback((next: (writes: ReadonlyMap<string, CellWrite>) => ReadonlyMap<string, CellWrite>) => {
    latest.current = next(latest.current);
    setHeld(latest.current);
  }, []);

  const written = useCallback((
    column: ColumnKey, path: readonly PathHop[], value: unknown, readsAsked: number,
  ) => {
    const cell = cellOf(column, path);
    const now = latest.current.get(cell);
    if (now && sameValue(now.value, value)) {
      change(writes => new Map(writes).set(cell, { ...now, readsAsked }));
      return;
    }
    const id = ++nextId.current;
    change(writes => new Map(writes).set(cell, { id, cell, column, path, value, readsAsked, marked: false }));
    setTimeout(() => {
      const write = latest.current.get(cell);
      if (write?.id === id) change(writes => new Map(writes).set(cell, { ...write, marked: true }));
    }, MARK_DELAY_MS);
  }, [change]);

  const refused = useCallback((column: ColumnKey, path: readonly PathHop[], value: unknown) => {
    const cell = cellOf(column, path);
    const now = latest.current.get(cell);
    if (!now || !sameValue(now.value, value)) return;
    change(writes => { const next = new Map(writes); next.delete(cell); return next; });
  }, [change]);

  /** A read the disk answered covers every write held before it was asked for, in a column mEdit
   *  could read, and logs one line for each the disk shows something else for. */
  const landed = useCallback((
    read: number, result: CompareResult | null, formKey: string, readable: (column: ColumnKey) => boolean,
  ) => {
    const covered = [...latest.current.values()].filter(w => w.readsAsked < read && readable(w.column));
    if (covered.length === 0) return;
    for (const write of covered) {
      const line = result ? differenceLine(result, formKey, write) : undefined;
      if (line !== undefined) log(line);
    }
    change(writes => {
      const next = new Map(writes);
      for (const write of covered) next.delete(write.cell);
      return next;
    });
  }, [change, log]);

  const clear = useCallback(() => { change(() => new Map()); }, [change]);

  const writeAt = useMemo((): WriteAt => (column, path) => held.get(cellOf(column, path)), [held]);

  return { writeAt, written, refused, landed, clear };
}
