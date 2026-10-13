import { z } from 'zod';
import { fileOrderConflictOf, foldPath, goToModCandidates, originLabel } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from './refusal';
import { modsNamed, type ModName } from './names';

interface ModConflicts {
  mod: string;
  enabled: boolean;
  wins: { file: string; over: string[] }[];
  loses: { file: string; winner: string }[];
}

const byFile = (a: { file: string }, b: { file: string }): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

function conflictsOf({ files, filesByMod, mods }: InstanceValue, wanted: readonly string[]): ModConflicts[] {
  const rows = new Map(wanted.map((mod): [string, ModConflicts] => [mod, { mod, enabled: mods.some((one) => one.kind === 'mod' && one.name === mod && one.enabled), wins: [], loses: [] }]));
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
    + 'With no mods given, every mod; otherwise the mods named, each by its name and, when a mod and a separator share it, its kind.',
  input: { mods: z.array(z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() })).optional() },
  of: (value: InstanceValue, { mods }: { mods?: ModName[] }): ModConflicts[] => {
    const named = mods === undefined ? value.mods.filter(({ kind }) => kind === 'mod') : modsNamed(value.mods, mods);
    const separator = named.find(({ kind }) => kind === 'separator');
    if (separator !== undefined) throw new Refusal(`"${separator.name}" is a separator; it has no files.`);
    return conflictsOf(value, named.map(({ name }) => name));
  },
};
