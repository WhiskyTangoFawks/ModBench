// mods-conflicts.md: one mod's file order conflicts, as a table.

import type { FileCopies, FileOrigin, InstanceValue, InstanceView, Mod, OriginFile } from '../instanceLoader/instance';
import { inFileOrderConflict, modOrigin, originLabel, sameOrigin } from '../instanceLoader/fileConflictIndex';
import type { ConflictCell, ConflictColumn, ConflictRow, ConflictTable } from '../wire/conflictTable';
import { byLevel, byName } from './fileTree';
import { fileStates, worstCell, worstRow } from './conflictStates';

const message = (text: string): ConflictTable => ({ kind: 'message', text });

/** The mod's own files that another enabled mod or Overwrite also provides. */
export function filesInConflict(value: Pick<InstanceValue, 'files' | 'filesByMod'>, name: string): OriginFile[] {
  const own = modOrigin(name);
  return (value.filesByMod.get(name) ?? [])
    .filter((file) => inFileOrderConflict(value.files.get(file.relativePath), own));
}

// Overwrite wins over every mod.
function winningRank(value: InstanceValue, origin: FileOrigin): number {
  return origin.kind === 'mod' ? value.mods.findIndex((entry) => entry.kind === 'mod' && entry.name === origin.name) : -1;
}

function providersOf(value: InstanceValue, file: OriginFile): readonly FileOrigin[] {
  return value.files.get(file.relativePath)?.providers ?? [];
}

type FileRow = Extract<ConflictRow, { kind: 'file' }>;

function rowsIn(files: readonly OriginFile[], prefix: string, fileRow: (file: OriginFile, name: string) => FileRow): ConflictRow[] {
  const { here, below } = byLevel(files, prefix);
  return [
    ...[...below].sort(byName).map(([name, under]): ConflictRow => {
      const rows = rowsIn(under, `${prefix}${name}/`, fileRow);
      return { kind: 'folder', name, path: `${prefix}${name}`, rows, state: worstRow(rows.map(({ state }) => state)) };
    }),
    ...[...here].sort(byName).map(([name, file]): ConflictRow => fileRow(file, name)),
  ];
}

const fileRowsIn = (rows: readonly ConflictRow[]): FileRow[] =>
  rows.flatMap((row) => (row.kind === 'folder' ? fileRowsIn(row.rows) : [row]));

/** Empty until the first read lands, so "not read yet" never reads as "no conflicts". */
export function conflictTable(
  { value, sequence }: Pick<InstanceView, 'value' | 'sequence'>, name: string, copies: readonly FileCopies[],
): ConflictTable {
  if (sequence === 0) return { kind: 'table', columns: [], rows: [] };
  const listed = value.mods.find((entry): entry is Mod => entry.kind === 'mod' && entry.name === name);
  if (listed === undefined) return message(`"${name}" is gone from the mod list.`);
  if (!listed.enabled) return message('Disabled: its files take no part in mod order.');
  const files = filesInConflict(value, name);
  if (files.length === 0) return message('No file order conflicts.');

  const origins: FileOrigin[] = [];
  for (const provider of files.flatMap((file) => providersOf(value, file))) {
    if (!origins.some((origin) => sameOrigin(origin, provider))) origins.push(provider);
  }
  origins.sort((a, b) => winningRank(value, b) - winningRank(value, a));
  const copiesByPath = new Map(copies.map((entry) => [entry.relativePath, entry.copies]));
  const fileRow = (file: OriginFile, rowName: string): FileRow => {
    const fileCopies = copiesByPath.get(file.relativePath) ?? [];
    const states = fileStates(fileCopies);
    const cells = origins.map((origin): ConflictCell | null => {
      if (!providersOf(value, file).some((provider) => sameOrigin(provider, origin))) return null;
      const index = fileCopies.findIndex((copy) => sameOrigin(copy.origin, origin));
      const copy = fileCopies[index];
      if (copy === undefined) return { state: null };
      return copy.kind === 'unreadable'
        ? { state: null, unreadable: copy.reason }
        : { state: states.cells[index] ?? null };
    });
    return { kind: 'file', name: rowName, path: file.relativePath, cells, state: states.row };
  };
  const rows = rowsIn(files, '', fileRow);
  const cellRows = fileRowsIn(rows);
  const columns: ConflictColumn[] = origins.map((origin, index) => ({
    name: originLabel(origin),
    origin,
    opened: sameOrigin(origin, modOrigin(name)),
    state: worstCell(cellRows.map(({ cells }) => cells[index]?.state ?? null)),
  }));
  return { kind: 'table', columns, rows };
}

/** The paths whose copies the table needs the answer for. */
export function conflictPaths(view: Pick<InstanceView, 'value' | 'sequence'>, name: string): string[] {
  const table = conflictTable(view, name, []);
  return table.kind === 'table' ? fileRowsIn(table.rows).map(({ path }) => path) : [];
}
