import { papyrusScriptAt, papyrusScriptFiles } from '../tables/gamePaths';
import type { DataFolderFiles } from '../instanceAdapter/instanceAdapter';
import type { ArchivedFileAddress, FileWinners, GameFolderArchived, StackedCopies } from './fileConflictIndex';

/** A Papyrus script: the copy of its first source the game folder's Creation Kit reads, and the compiled script the
 *  game takes, each as mod order resolves it, the Data folder's last. */
export interface PapyrusScript {
  readonly name: string;
  readonly source?: string;
  readonly compiled?: string;
  /** Where an archive holds its compiled script, else its first source, which shows where no loose file does. */
  readonly archived?: ArchivedCopy;
}

export type ArchivedCopy = { readonly kind: 'archived' } & ArchivedFileAddress;

/** Each Papyrus script an enabled mod, Overwrite, the Data folder or an archive holds, by name. `archived` is each
 *  archived file's copy, by its lower-case path. */
export function papyrusScriptsOf(files: FileWinners, dataFolderFiles: DataFolderFiles, release: string | undefined, archived: ReadonlyMap<string, ArchivedCopy> = new Map()): PapyrusScript[] {
  const inData = dataFolderFiles.kind === 'listed' ? dataFolderFiles.files : new Map<string, { relativePath: string; path: string }>();
  const copyOf = (relativePath: string): string | undefined => files.get(relativePath)?.winner ?? inData.get(relativePath.toLowerCase())?.path;
  const names = new Map<string, string>();
  for (const relativePath of [...[...files.values(), ...inData.values()].map((file) => file.relativePath), ...[...archived.values()].map(({ file }) => file)]) {
    const script = papyrusScriptAt(release, relativePath);
    if (script !== undefined && !names.has(script.name.toLowerCase())) names.set(script.name.toLowerCase(), script.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b)).map((name) => {
    const placed = papyrusScriptFiles(release, name);
    const source = placed?.sources.map(copyOf).find((file) => file !== undefined);
    const compiled = placed && copyOf(placed.compiled);
    const inArchive = placed && [placed.compiled, ...placed.sources].map((path) => archived.get(path.toLowerCase())).find((copy) => copy !== undefined);
    return { name, ...source === undefined ? {} : { source }, ...compiled === undefined ? {} : { compiled }, ...inArchive === undefined ? {} : { archived: inArchive } };
  });
}

/** Each archived file's copy, by its lower-case path: the winning-most archived copy in the stack, else the game folder's. */
export function archivedCopiesOf({ stackedCopies, gameFolderArchived }: { readonly stackedCopies: StackedCopies; readonly gameFolderArchived: GameFolderArchived }): ReadonlyMap<string, ArchivedCopy> {
  const copies = new Map<string, ArchivedCopy>();
  for (const [path, address] of gameFolderArchived.copies) copies.set(path, { kind: 'archived', ...address });
  for (const { relativePath, copies: held } of stackedCopies) {
    const archived = held.map(({ at }) => at).find((at) => at.kind === 'archived');
    if (archived !== undefined) copies.set(relativePath.toLowerCase(), archived);
  }
  return copies;
}
