import { papyrusScriptAt, papyrusScriptFiles } from '../tables/gamePaths';
import type { DataFolderFiles } from '../instanceAdapter/instanceAdapter';
import type { FileWinners, GameFolderArchived, StackedCopies } from './fileConflictIndex';

/** A Papyrus script: the copy of its first source the game folder's Creation Kit reads, as mod order resolves it, the
 *  Data folder's last, and the path of its compiled script, whose copy the game gets is a File symbol's. */
export interface PapyrusScript {
  readonly name: string;
  readonly source?: string;
  readonly compiledPath: string;
}

/** Each Papyrus script an enabled mod, Overwrite, the Data folder or an archive holds, by name. */
export function papyrusScriptsOf(files: FileWinners, dataFolderFiles: DataFolderFiles, release: string | undefined, archivedPaths: Iterable<string> = []): PapyrusScript[] {
  const inData = dataFolderFiles.kind === 'listed' ? dataFolderFiles.files : new Map<string, { relativePath: string; path: string }>();
  const copyOf = (relativePath: string): string | undefined => files.get(relativePath)?.winner ?? inData.get(relativePath.toLowerCase())?.path;
  const names = new Map<string, string>();
  for (const relativePath of [...[...files.values(), ...inData.values()].map((file) => file.relativePath), ...archivedPaths]) {
    const script = papyrusScriptAt(release, relativePath);
    if (script !== undefined && !names.has(script.name.toLowerCase())) names.set(script.name.toLowerCase(), script.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b)).flatMap((name) => {
    const placed = papyrusScriptFiles(release, name);
    if (placed === undefined) return [];
    const source = placed.sources.map(copyOf).find((file) => file !== undefined);
    return [{ name, ...source === undefined ? {} : { source }, compiledPath: placed.compiled }];
  });
}

/** Each path an archive holds: one in a mod's archive the game loads, one in the game folder's. */
export function archivedPathsOf({ stackedCopies, gameFolderArchived }: { readonly stackedCopies: StackedCopies; readonly gameFolderArchived: GameFolderArchived }): string[] {
  return [
    ...[...stackedCopies].filter(({ copies }) => copies.some(({ at }) => at.kind === 'archived')).map(({ relativePath }) => relativePath),
    ...[...gameFolderArchived.copies.values()].map(({ file }) => file),
  ];
}
