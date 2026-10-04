// mods-conflicts.md: one mod's file order conflicts, as a table.

import type { FileOrigin, InstanceValue, InstanceView, Mod, OriginFile } from '../instanceLoader/instance';
import { goToModCandidates, modOrigin, originLabel, sameOrigin } from '../instanceLoader/fileConflictIndex';
import type { ConflictCell, ConflictColumn, ConflictRow, ConflictTable } from '../wire/conflictTable';
import { byLevel, byName } from './fileTree';

const message = (text: string): ConflictTable => ({ kind: 'message', text });

/** The mod's own files that another enabled mod or Overwrite also provides. */
export function filesInConflict(value: Pick<InstanceValue, 'files' | 'filesByMod'>, name: string): OriginFile[] {
  const own = modOrigin(name);
  return (value.filesByMod.get(name) ?? [])
    .filter((file) => goToModCandidates(value.files.get(file.relativePath), own).length > 0);
}

// Overwrite wins over every mod.
function winningRank(value: InstanceValue, origin: FileOrigin): number {
  return origin.kind === 'mod' ? value.mods.findIndex((entry) => entry.kind === 'mod' && entry.name === origin.name) : -1;
}

function providersOf(value: InstanceValue, file: OriginFile): readonly FileOrigin[] {
  return value.files.get(file.relativePath)?.providers ?? [];
}

function rowsIn(
  files: readonly OriginFile[], prefix: string, cellsOf: (file: OriginFile) => (ConflictCell | null)[],
): ConflictRow[] {
  const { here, below } = byLevel(files, prefix);
  return [
    ...[...below].sort(byName).map(([name, under]): ConflictRow =>
      ({ kind: 'folder', name, path: `${prefix}${name}`, rows: rowsIn(under, `${prefix}${name}/`, cellsOf) })),
    ...[...here].sort(byName).map(([name, file]): ConflictRow =>
      ({ kind: 'file', name, path: file.relativePath, cells: cellsOf(file) })),
  ];
}

/** Empty until the first read lands, so "not read yet" never reads as "no conflicts". */
export function conflictTable({ value, sequence }: Pick<InstanceView, 'value' | 'sequence'>, name: string): ConflictTable {
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
  const opened = modOrigin(name);
  const columns: ConflictColumn[] = origins.map((origin) =>
    ({ name: originLabel(origin), isMod: origin.kind === 'mod', opened: sameOrigin(origin, opened) }));
  const cellsOf = (file: OriginFile) => {
    const providers = providersOf(value, file);
    return origins.map((origin) => (providers.some((provider) => sameOrigin(provider, origin)) ? {} : null));
  };
  return { kind: 'table', columns, rows: rowsIn(files, '', cellsOf) };
}
