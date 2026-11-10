import { z } from 'zod';
import type { FileOrigin } from '../instanceAdapter/instanceAdapter';
import { copyInConflict, foldPath, sameOrigin, originKey, originLabel } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { indicatorsOf, isFileNotGotten, pathTagsOf, type ModIndicator } from '../drivingLib/modFileStates';
import { fileStates } from '../drivingLib/conflictStates';
import { copiesToRead, filesOfOrigin } from '../drivingLib/copiesToRead';
import { modifiedMs, sameCopies, type CopyReads } from '../drivingLib/sameCopies';
import type { ArchivedCopies } from '../drivingLib/archivedCopies';
import { Refusal } from '../drivingLib/refusal';
import type { ConflictCellState, ConflictRowState } from '../wire/conflictTable';
import { CONTAINER_NAME, containersNamed, originOf, type ContainerName } from './names';

interface Contents {
  state: ConflictCellState | null;
  row: ConflictRowState | null;
  size?: number;
  modified?: number;
  unreadable?: string;
}

interface ModConflicts {
  kind: FileOrigin['kind'];
  mod: string;
  enabled: boolean;
  wins: { file: string; over: string[] }[];
  loses: { file: string; winner: string }[];
  indicators: ModIndicator[];
  files: { file: string; excluded: boolean; gotten: boolean; publisherTags: string[]; contents?: Contents }[];
}

const byFile = (a: { file: string }, b: { file: string }): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

function rowOf(value: InstanceValue, origin: FileOrigin, contents: ReadonlyMap<string, Contents>): ModConflicts {
  const mod = originLabel(origin);
  const entry = origin.kind === 'mod' ? value.mods.find((one) => one.kind === 'mod' && one.name === mod) : undefined;
  const enabled = origin.kind === 'runtimeOutput' || entry?.enabled === true;
  const own = filesOfOrigin(value, origin);
  const covering = value.publisherConfiguration.kind === 'read' ? value.publisherConfiguration.covering : () => [];
  return {
    kind: origin.kind, mod, enabled, wins: [], loses: [],
    indicators: entry?.kind === 'mod' && enabled ? indicatorsOf(value, entry, own) : [],
    files: own.map((file) => ({
      file: file.includedPath, excluded: file.excluded, gotten: !isFileNotGotten(value, origin, enabled, file),
      publisherTags: pathTagsOf(covering, file.path, origin.kind === 'mod' ? mod : undefined).map(({ name }) => name),
      ...contentsOf(contents.get(`${originKey(origin)}\0${file.relativePath}`)),
    })).sort(byFile),
  };
}

const contentsOf = (contents: Contents | undefined) => (contents === undefined ? {} : { contents });

type ArchivedReads = Pick<ArchivedCopies, 'read'>;

async function contentsIn(value: InstanceValue, reads: CopyReads, archived: ArchivedReads, wanted: readonly FileOrigin[]): Promise<Map<string, Contents>> {
  const conflicting = wanted.map((origin) => [origin, filesOfOrigin(value, origin).filter((file) => copyInConflict(value.stackedCopies.get(file.relativePath), origin))] as const);
  const paths = [...new Set(conflicting.flatMap(([, files]) => files.map(({ relativePath }) => relativePath)))];
  const copiesByPath = new Map((await sameCopies(reads, archived, copiesToRead(value, paths))).map(({ relativePath, copies }) => [relativePath, copies]));
  return new Map(conflicting.flatMap(([origin, files]) => files.map((file): [string, Contents] => {
    const copies = copiesByPath.get(file.relativePath) ?? [];
    const states = fileStates(copies);
    const index = copies.findIndex((copy) => sameOrigin(copy.origin, origin));
    const copy = copies[index];
    const own = copy?.kind === 'read' ? { size: Number(copy.size), modified: modifiedMs(copy) } : { unreadable: copy?.reason };
    return [`${originKey(origin)}\0${file.relativePath}`, { state: states.cells[index] ?? null, row: states.row, ...own }];
  })));
}

function conflictsOf(value: InstanceValue, wanted: readonly FileOrigin[], contents: ReadonlyMap<string, Contents>): ModConflicts[] {
  const rows = new Map(wanted.map((origin): [string, ModConflicts] => [originKey(origin), rowOf(value, origin, contents)]));
  const ownPaths = new Map(wanted.map((origin) => [originKey(origin), new Map(filesOfOrigin(value, origin).map(({ relativePath }) => [foldPath(relativePath), relativePath]))]));
  for (const { relativePath, copies: [winner, ...losers] } of value.stackedCopies) {
    if (winner === undefined || losers.length === 0) continue;
    rows.get(originKey(winner.origin))?.wins.push({ file: relativePath, over: losers.map(({ origin }) => originLabel(origin)) });
    for (const { origin } of losers) {
      rows.get(originKey(origin))?.loses.push({ file: ownPaths.get(originKey(origin))?.get(foldPath(relativePath)) ?? relativePath, winner: originLabel(winner.origin) });
    }
  }
  return [...rows.values()].map((row) => ({ ...row, wins: row.wins.sort(byFile), loses: row.loses.sort(byFile) }));
}

export const FILE_CONFLICTS = {
  name: 'list_file_conflicts',
  input: { mods: z.array(CONTAINER_NAME).optional() },
  of: async (value: InstanceValue, reads: CopyReads, archived: ArchivedReads, { mods }: { mods?: ContainerName[] }): Promise<ModConflicts[]> => {
    const named = mods === undefined ? value.mods.filter(({ kind }) => kind === 'mod') : containersNamed(value, mods);
    const separator = named.find(({ kind }) => kind === 'separator');
    if (separator !== undefined) throw new Refusal(`"${separator.name}" is a separator; it has no files.`);
    const wanted = named.map(originOf);
    return conflictsOf(value, wanted, await contentsIn(value, reads, archived, wanted));
  },
};
