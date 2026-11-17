import { papyrusScriptAt, papyrusScriptFiles } from '../tables/gamePaths';
import type { DataFolderFiles } from '../instanceAdapter/instanceAdapter';
import type { FileWinners, GameFolderArchived, StackedCopies } from './fileConflictIndex';

/** A Papyrus script: the Data-relative path of the first source the Creation Kit reads that a mod, Overwrite or the Data
 *  folder holds, and of its compiled script. */
export interface PapyrusScript {
  readonly name: string;
  readonly sourceDataPath?: string;
  readonly compiledDataPath: string;
}

/** Each Papyrus script an enabled mod, Overwrite, the Data folder or an archive holds, by name. */
export function papyrusScriptsOf(files: FileWinners, dataFolderFiles: DataFolderFiles, release: string | undefined, archivedPaths: Iterable<string> = []): PapyrusScript[] {
  const inData = dataFolderFiles.kind === 'listed' ? dataFolderFiles.files : new Map<string, { relativePath: string; path: string }>();
  const holds = (relativePath: string): boolean => files.get(relativePath) !== undefined || inData.has(relativePath.toLowerCase());
  const placed = new Map<string, PapyrusScript>();
  for (const relativePath of [...[...files.values(), ...inData.values()].map((file) => file.relativePath), ...archivedPaths]) {
    const script = papyrusScriptAt(release, relativePath);
    const placing = script && papyrusScriptFiles(release, script.name);
    if (script === undefined || placing === undefined || placed.has(script.name.toLowerCase())) continue;
    const sourceDataPath = placing.sources.find(holds);
    placed.set(script.name.toLowerCase(), { name: script.name, ...sourceDataPath === undefined ? {} : { sourceDataPath }, compiledDataPath: placing.compiled });
  }
  return [...placed.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Each path an archive holds: one in a mod's archive the game loads, one in the game folder's. */
export function archivedPathsOf({ stackedCopies, gameFolderArchived }: { readonly stackedCopies: StackedCopies; readonly gameFolderArchived: GameFolderArchived }): string[] {
  return [
    ...[...stackedCopies].filter(({ copies }) => copies.some(({ at }) => at.kind === 'archived')).map(({ relativePath }) => relativePath),
    ...[...gameFolderArchived.copies.values()].map(({ file }) => file),
  ];
}
