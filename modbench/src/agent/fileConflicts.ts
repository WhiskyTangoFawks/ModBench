import { z } from 'zod';
import { fileOrderConflictOf, foldPath, inFileOrderConflict, modOrigin, sameOrigin, goToModCandidates, originLabel } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { indicatorsOf, isFileNotGotten, pathTagsOf, type ModIndicator } from '../drivingLib/modFileStates';
import { fileStates } from '../drivingLib/conflictStates';
import { copiesToRead } from '../drivingLib/copiesToRead';
import { modifiedMs, sameCopies, type CopyReads } from '../drivingLib/sameCopies';
import { Refusal } from '../drivingLib/refusal';
import type { ConflictCellState, ConflictRowState } from '../wire/conflictTable';
import { modsNamed, type ModName } from './names';

interface Contents {
  state: ConflictCellState | null;
  row: ConflictRowState | null;
  size?: number;
  modified?: number;
  unreadable?: string;
}

interface ModConflicts {
  mod: string;
  enabled: boolean;
  wins: { file: string; over: string[] }[];
  loses: { file: string; winner: string }[];
  indicators: ModIndicator[];
  files: { file: string; excluded: boolean; gotten: boolean; publisherTags: string[]; contents?: Contents }[];
}

const byFile = (a: { file: string }, b: { file: string }): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

function rowOf(value: InstanceValue, mod: string, contents: ReadonlyMap<string, Contents>): ModConflicts {
  const entry = value.mods.find((one) => one.kind === 'mod' && one.name === mod);
  const enabled = entry?.enabled === true;
  const own = value.filesByMod.get(mod) ?? [];
  const covering = value.publisherConfiguration.kind === 'read' ? value.publisherConfiguration.covering : () => [];
  return {
    mod, enabled, wins: [], loses: [],
    indicators: entry?.kind === 'mod' && enabled ? indicatorsOf(value, entry, own) : [],
    files: own.map((file) => ({
      file: file.includedPath, excluded: file.excluded, gotten: !isFileNotGotten(value, modOrigin(mod), enabled, file),
      publisherTags: pathTagsOf(covering, file.path, mod).map(({ name }) => name),
      ...contentsOf(contents.get(`${mod}\0${file.relativePath}`)),
    })).sort(byFile),
  };
}

const contentsOf = (contents: Contents | undefined) => (contents === undefined ? {} : { contents });

async function contentsIn(value: InstanceValue, reads: CopyReads, wanted: readonly string[]): Promise<Map<string, Contents>> {
  const conflicting = wanted.map((mod) => [mod, (value.filesByMod.get(mod) ?? []).filter((file) => inFileOrderConflict(value.files.get(file.relativePath), modOrigin(mod)))] as const);
  const paths = [...new Set(conflicting.flatMap(([, files]) => files.map(({ relativePath }) => relativePath)))];
  const copiesByPath = new Map((await sameCopies(reads, copiesToRead(value, paths))).map(({ relativePath, copies }) => [relativePath, copies]));
  return new Map(conflicting.flatMap(([mod, files]) => files.map((file): [string, Contents] => {
    const copies = copiesByPath.get(file.relativePath) ?? [];
    const states = fileStates(copies);
    const index = copies.findIndex((copy) => sameOrigin(copy.origin, modOrigin(mod)));
    const copy = copies[index];
    const own = copy?.kind === 'read' ? { size: Number(copy.size), modified: modifiedMs(copy) } : { unreadable: copy?.reason };
    return [`${mod}\0${file.relativePath}`, { state: states.cells[index] ?? null, row: states.row, ...own }];
  })));
}

function conflictsOf(value: InstanceValue, wanted: readonly string[], contents: ReadonlyMap<string, Contents>): ModConflicts[] {
  const { files, filesByMod } = value;
  const rows = new Map(wanted.map((mod): [string, ModConflicts] => [mod, rowOf(value, mod, contents)]));
  const ownPaths = new Map(wanted.map((mod) => [mod, new Map((filesByMod.get(mod) ?? []).map(({ relativePath }) => [foldPath(relativePath), relativePath]))]));
  for (const entry of files) {
    for (const provider of entry.providers) {
      const row = provider.kind === 'mod' ? rows.get(provider.name) : undefined;
      if (row === undefined) continue;
      const conflict = fileOrderConflictOf(entry, provider);
      if (conflict === 'none') continue;
      if (conflict === 'wins') {
        row.wins.push({ file: entry.relativePath, over: goToModCandidates(entry, provider).map(originLabel) });
      } else {
        row.loses.push({ file: ownPaths.get(row.mod)?.get(foldPath(entry.relativePath)) ?? entry.relativePath, winner: originLabel(entry.winnerOrigin) });
      }
    }
  }
  return [...rows.values()].map((row) => ({ ...row, wins: row.wins.sort(byFile), loses: row.loses.sort(byFile) }));
}

export const FILE_CONFLICTS = {
  name: 'list_file_conflicts',
  description: 'Each mod\'s file order conflicts: the files it wins and over which mods, and the files it loses and to which winner. '
    + 'A file in conflict also has its contents: the conflict table\'s state of the mod\'s copy and of the file\'s row, and the copy\'s size and date modified. '
    + 'Also its indicators and every file it holds: whether the file is excluded, whether the game gets it, and the publisher tags that cover it. '
    + 'Whether a file differs from its manifest is list_mod_statuses. '
    + 'With no mods given, every mod; otherwise the mods named, each by its name and, when a mod and a separator share it, its kind.',
  input: { mods: z.array(z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() })).optional() },
  of: async (value: InstanceValue, reads: CopyReads, { mods }: { mods?: ModName[] }): Promise<ModConflicts[]> => {
    const named = mods === undefined ? value.mods.filter(({ kind }) => kind === 'mod') : modsNamed(value, mods);
    const separator = named.find(({ kind }) => kind === 'separator');
    if (separator !== undefined) throw new Refusal(`"${separator.name}" is a separator; it has no files.`);
    const wanted = named.map(({ name }) => name);
    return conflictsOf(value, wanted, await contentsIn(value, reads, wanted));
  },
};
