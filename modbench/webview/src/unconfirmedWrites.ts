import { useCallback, useMemo, useRef, useState } from 'react';
import { columnKey } from './columnKey';
import { displayValue } from './modelValue';
import { defaultOf, isPureLinkArray, recordLabel, variantFor } from './recordUtils';
import type { ColumnKey, CompareResult, FieldDiff, FieldMetadata, PathHop, RecordEditEnvelope } from './types';

const MARK_DELAY_MS = 300;

/** A write the panel marks in a cell until a read covers it (common.md, Unconfirmed writes). A set
 *  shows its value there; an element added, removed or moved leaves the rows as the disk has them. */
export interface CellWrite {
  readonly id: number;
  readonly cell: string;
  readonly column: ColumnKey;
  readonly edit: RecordEditEnvelope;
  /** The array an element is added to, removed from or moved in, as the panel last read it. */
  readonly array: DiskCell | undefined;
  /** The grid row the panel wrote it from. A write from elsewhere names only the path. */
  readonly row: string | undefined;
  /** Reads asked for before the host held the panel's reads for it, none of which can cover it. */
  readonly readsAsked: number;
  readonly marked: boolean;
}

export type WriteAt = (column: ColumnKey, path: readonly PathHop[]) => CellWrite | undefined;

const cellOf = (column: ColumnKey, path: readonly PathHop[]): string => JSON.stringify([column, path]);

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface DiskCell { row: string; label: string; meta: FieldMetadata; value: unknown }

interface Node { diff: FieldDiff | undefined; meta: FieldMetadata | null | undefined }

// One hop down the rows as the grid builds them: an element of a sorted array is the row its value
// at that place in this column names.
function hopDown(diff: FieldDiff, meta: FieldMetadata, hop: PathHop, column: ColumnKey): Node {
  const owner = diff.values[column];
  const children = diff.children ?? [];
  if (hop.kind === 'member') {
    const member = meta.fields?.find(f => f.name === hop.name);
    return { diff: children.find(c => c.fieldName === hop.name), meta: member && variantFor(member, owner, meta) };
  }
  if (hop.kind === 'key') return { diff: children.find(c => c.fieldName === hop.key), meta: meta.elementType };
  if (!isPureLinkArray(meta)) return { diff: children[hop.index], meta: meta.elementType };
  const linked: unknown = Array.isArray(owner) ? owner[hop.index] : undefined;
  return { diff: children.find(c => c.fieldName === linked), meta: meta.elementType };
}

function diskCellAt(result: CompareResult, column: ColumnKey, path: readonly PathHop[]): DiskCell | undefined {
  const [root, ...hops] = path;
  if (root?.kind !== 'member') return undefined;
  let node: Node = {
    diff: result.diffs.find(d => d.fieldName === root.name),
    meta: result.overrides.flatMap(o => o.fields).find(f => f.metadata.name === root.name)?.metadata,
  };
  let row = root.name;
  for (const hop of hops) {
    if (!node.diff || !node.meta) return undefined;
    node = hopDown(node.diff, node.meta, hop, column);
    row = `${row}.${node.diff?.fieldName ?? ''}`;
  }
  const { diff, meta } = node;
  if (!diff || !meta) return undefined;
  return { row, label: meta.displayLabel ?? diff.fieldName, meta, value: diff.values[column] ?? defaultOf(meta) };
}

const arrayPathOf = ({ op, path }: RecordEditEnvelope): readonly PathHop[] => (op === 'add' ? path : path.slice(0, -1));

const elements = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function showsShape(edit: RecordEditEnvelope, before: unknown[], after: unknown[]): boolean {
  if (edit.op === 'add') return after.length > before.length;
  if (edit.op === 'remove') return after.length < before.length;
  const from = edit.path.at(-1);
  return from?.kind === 'index' && typeof edit.value === 'number' && sameValue(after[edit.value], before[from.index]);
}

const SHAPE_UNSHOWN = {
  add: (where: string) => `An element was added to ${where}, and the disk does not show it.`,
  remove: (where: string) => `An element was removed from ${where}, and the disk does not show it.`,
  move: (where: string) => `An element was moved in ${where}, and the disk does not show the move.`,
};

// A sorted array's element sits where the write moved it, so the row the panel wrote from may hold
// another element by the time the read lands.
function differenceLine(result: CompareResult, formKey: string, write: CellWrite): string | undefined {
  const plugin = result.overrides.find(o => columnKey(o.plugin, o.origin) === write.column)?.plugin;
  if (plugin === undefined) return undefined;
  const where = (label: string) => `${label} of ${recordLabel(result.overrides, formKey)} in "${plugin}"`;
  const { edit, array } = write;
  if (edit.op !== 'set') {
    if (!array) return undefined;
    const after = elements(diskCellAt(result, write.column, arrayPathOf(edit))?.value);
    return showsShape(edit, elements(array.value), after) ? undefined : SHAPE_UNSHOWN[edit.op](where(array.label));
  }
  const disk = diskCellAt(result, write.column, edit.path);
  if (!disk || (write.row !== undefined && write.row !== disk.row)) return undefined;
  const written = displayValue(edit.value, disk.meta);
  const shown = displayValue(disk.value, disk.meta);
  return written === shown ? undefined : `${where(disk.label)} was written "${written}", and the disk now shows "${shown}".`;
}

export function useCellWrites(log: (line: string) => void) {
  const [held, setHeld] = useState<ReadonlyMap<string, CellWrite>>(new Map());
  // A callback reads the writes as last changed, which a render may not have caught up with.
  const latest = useRef(held);
  const lastRead = useRef<CompareResult | null>(null);
  const nextId = useRef(0);
  const change = useCallback((next: (writes: ReadonlyMap<string, CellWrite>) => ReadonlyMap<string, CellWrite>) => {
    latest.current = next(latest.current);
    setHeld(latest.current);
  }, []);

  const written = useCallback((column: ColumnKey, edit: RecordEditEnvelope, readsAsked: number, row?: string) => {
    const cell = cellOf(column, edit.path);
    const now = latest.current.get(cell);
    if (now && sameValue(now.edit, edit)) {
      change(writes => new Map(writes).set(cell, { ...now, readsAsked }));
      return;
    }
    const id = ++nextId.current;
    const array = edit.op === 'set' || !lastRead.current ? undefined : diskCellAt(lastRead.current, column, arrayPathOf(edit));
    change(writes => new Map(writes).set(cell, { id, cell, column, edit, array, row, readsAsked, marked: false }));
    setTimeout(() => {
      const write = latest.current.get(cell);
      if (write?.id === id) change(writes => new Map(writes).set(cell, { ...write, marked: true }));
    }, MARK_DELAY_MS);
  }, [change]);

  const refused = useCallback((column: ColumnKey, edit: RecordEditEnvelope) => {
    const cell = cellOf(column, edit.path);
    const now = latest.current.get(cell);
    if (!now || !sameValue(now.edit, edit)) return;
    change(writes => { const next = new Map(writes); next.delete(cell); return next; });
  }, [change]);

  /** A read the disk answered covers every write held before it was asked for, in a column mEdit
   *  could read, and logs one line for each the disk shows something else for. */
  const landed = useCallback((
    read: number, result: CompareResult | null, formKey: string, readable: (column: ColumnKey) => boolean,
  ) => {
    lastRead.current = result;
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
