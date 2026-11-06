import { papyrusScriptAt, papyrusScriptFiles } from '../tables/gamePaths';
import type { DataFolderFiles } from '../instanceAdapter/instanceAdapter';
import type { FileWinners } from './fileConflictIndex';

/** A Papyrus script: the copy of its first source the game folder's Creation Kit reads, and the compiled script the
 *  game takes, each as mod order resolves it, the Data folder's last. */
export interface PapyrusScript {
  readonly name: string;
  readonly source?: string;
  readonly compiled?: string;
}

/** Each Papyrus script an enabled mod, Overwrite or the Data folder holds, by name. */
export function papyrusScriptsOf(files: FileWinners, dataFolderFiles: DataFolderFiles, release: string | undefined): PapyrusScript[] {
  const inData = dataFolderFiles.kind === 'listed' ? dataFolderFiles.files : new Map<string, { relativePath: string; path: string }>();
  const copyOf = (relativePath: string): string | undefined => files.get(relativePath)?.winner ?? inData.get(relativePath.toLowerCase())?.path;
  const names = new Map<string, string>();
  for (const relativePath of [...files.values(), ...inData.values()].map((file) => file.relativePath)) {
    const script = papyrusScriptAt(release, relativePath);
    if (script !== undefined && !names.has(script.name.toLowerCase())) names.set(script.name.toLowerCase(), script.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b)).map((name) => {
    const placed = papyrusScriptFiles(release, name);
    const source = placed?.sources.map(copyOf).find((file) => file !== undefined);
    const compiled = placed && copyOf(placed.compiled);
    return { name, ...source === undefined ? {} : { source }, ...compiled === undefined ? {} : { compiled } };
  });
}
