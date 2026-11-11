import { z } from 'zod';
import type { FileOrigin } from '../instanceAdapter/instanceAdapter';
import { foldPath, originKey, originLabel, type StackedCopy } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { indicatorsOf, isFileNotGotten, pathTagsOf, type ModIndicator } from '../drivingLib/modFileStates';
import { fileStates } from '../drivingLib/conflictStates';
import { filesOfOrigin } from '../drivingLib/copiesToRead';
import { modifiedMs, sameCopies, type CopyReads } from '../drivingLib/sameCopies';
import type { ArchivedCopies } from '../drivingLib/archivedCopies';
import { Refusal } from '../drivingLib/refusal';
import type { ConflictCellState, ConflictRowState } from '../wire/conflictTable';
import { CONTAINER_NAME, containersNamed, originOf, type ContainerName } from './names';
import { FILTER, fitting, holding } from './tooLarge';

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
  wins: { file: string; over: string[]; contents?: Contents }[];
  loses: { file: string; winner: string; contents?: Contents }[];
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
      ...contentsOf(contents.get(keyOf(origin, file.relativePath))),
    })).sort(byFile),
  };
}

const contentsOf = (contents: Contents | undefined) => (contents === undefined ? {} : { contents });

const keyOf = (origin: FileOrigin, relativePath: string): string => `${originKey(origin)}\0${foldPath(relativePath)}`;

type ArchivedReads = Pick<ArchivedCopies, 'stamps' | 'hashes'>;

async function contentsIn(value: InstanceValue, reads: CopyReads, archived: ArchivedReads, wanted: readonly FileOrigin[]): Promise<Map<string, Contents>> {
  const isWanted = new Set(wanted.map(originKey));
  const conflicting = [...value.stackedCopies].filter(({ copies }) => copies.length > 1 && copies.some(({ origin }) => isWanted.has(originKey(origin))));
  return new Map((await sameCopies(reads, archived, conflicting)).flatMap(({ relativePath, copies }) => {
    const states = fileStates(copies);
    return copies.flatMap((copy, index): [string, Contents][] => {
      if (!isWanted.has(originKey(copy.origin))) return [];
      const own = copy.kind === 'read' ? { size: Number(copy.size), modified: modifiedMs(copy) } : { unreadable: copy.reason };
      return [[keyOf(copy.origin, relativePath), { state: states.cells[index] ?? null, row: states.row, ...own }]];
    });
  }));
}

function conflictsOf(value: InstanceValue, wanted: readonly FileOrigin[], contents: ReadonlyMap<string, Contents>): ModConflicts[] {
  const rows = new Map(wanted.map((origin): [string, ModConflicts] => [originKey(origin), rowOf(value, origin, contents)]));
  const ownPaths = new Map(wanted.map((origin) => [originKey(origin), new Map(filesOfOrigin(value, origin).map(({ relativePath }) => [foldPath(relativePath), relativePath]))]));
  const archivedContents = ({ origin, at }: StackedCopy, relativePath: string) => (at.kind === 'archived' ? contentsOf(contents.get(keyOf(origin, relativePath))) : {});
  for (const { relativePath, copies: [winner, ...losers] } of value.stackedCopies) {
    if (winner === undefined || losers.length === 0) continue;
    rows.get(originKey(winner.origin))?.wins.push({ file: relativePath, over: losers.map(({ origin }) => originLabel(origin)), ...archivedContents(winner, relativePath) });
    for (const loser of losers) {
      const file = ownPaths.get(originKey(loser.origin))?.get(foldPath(relativePath)) ?? relativePath;
      rows.get(originKey(loser.origin))?.loses.push({ file, winner: originLabel(winner.origin), ...archivedContents(loser, relativePath) });
    }
  }
  return [...rows.values()].map((row) => ({ ...row, wins: row.wins.sort(byFile), loses: row.loses.sort(byFile) }));
}

// mods.md, Order and view state, story 2.
function holdingFiles(row: ModConflicts, held: (name: string) => boolean): ModConflicts {
  if (held(row.mod)) return row;
  const pathHeld = ({ file }: { file: string }) => file.split(/[\\/]/).some(held);
  return { ...row, wins: row.wins.filter(pathHeld), loses: row.loses.filter(pathHeld), files: row.files.filter(pathHeld) };
}

const MODS_NARROW = 'mods narrows the read to the mods you name.';
const FILTER_NARROWS = 'filter keeps the files whose path holds it in a folder or file name, in any case, and every file of a mod whose name holds it.';

export const FILE_CONFLICTS = {
  name: 'list_file_conflicts',
  input: { mods: z.array(CONTAINER_NAME).optional(), ...FILTER },
  of: async (value: InstanceValue, reads: CopyReads, archived: ArchivedReads, { mods, filter }: { mods?: ContainerName[]; filter?: string }): Promise<ModConflicts[]> => {
    const named = mods === undefined ? value.mods.filter(({ kind }) => kind === 'mod') : containersNamed(value, mods);
    const separator = named.find(({ kind }) => kind === 'separator');
    if (separator !== undefined) throw new Refusal(`"${separator.name}" is a separator; it has no files.`);
    const wanted = named.map(originOf);
    const held = holding(filter);
    const rows = conflictsOf(value, wanted, await contentsIn(value, reads, archived, wanted)).map((row) => holdingFiles(row, held));
    return fitting(rows, (all) => ({
      ...mods === undefined
        ? { mods: all.length }
        : { byMod: all.map(({ kind, mod, wins, loses, files }) => ({ kind, mod, wins: wins.length, loses: loses.length, files: files.length })) },
      narrow: all.length > 1 ? `${MODS_NARROW} ${FILTER_NARROWS}` : FILTER_NARROWS,
    }));
  },
};
