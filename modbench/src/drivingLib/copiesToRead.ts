import type { FileOrigin, OriginFile } from '../instanceLoader/instance';
import { foldPath, originKey } from '../instanceLoader/fileConflictIndex';
import type { FileToCompare } from './sameCopies';
import { present } from '../ports/present';

type CopyFile = Pick<OriginFile, 'relativePath' | 'sourcePath'>;

interface CopiesIn {
  readonly files: { get(relativePath: string): { readonly providers: readonly FileOrigin[] } | undefined };
  readonly filesByMod: ReadonlyMap<string, readonly CopyFile[]>;
  readonly overwriteFiles: readonly CopyFile[];
}

/** The files an origin holds. */
export const filesOfOrigin = <File>(
  value: { readonly filesByMod: ReadonlyMap<string, readonly File[]>; readonly overwriteFiles: readonly File[] }, origin: FileOrigin,
): readonly File[] => (origin.kind === 'mod' ? value.filesByMod.get(origin.name) ?? [] : value.overwriteFiles);

export function copyPathsOf(value: Pick<CopiesIn, 'filesByMod' | 'overwriteFiles'>, origin: FileOrigin): ReadonlyMap<string, string> {
  return new Map(filesOfOrigin(value, origin).map((file) => [foldPath(file.relativePath), file.sourcePath]));
}

export function copiesToRead(value: CopiesIn, relativePaths: readonly string[]): FileToCompare[] {
  const byOrigin = new Map<string, ReadonlyMap<string, string>>();
  const copyPath = (origin: FileOrigin, relativePath: string): string => {
    const key = originKey(origin);
    let paths = byOrigin.get(key);
    if (paths === undefined) {
      paths = copyPathsOf(value, origin);
      byOrigin.set(key, paths);
    }
    return present(paths.get(foldPath(relativePath)), `${key}'s copy of ${relativePath}`);
  };
  return relativePaths.map((relativePath) => ({
    relativePath,
    providers: (value.files.get(relativePath)?.providers ?? []).map((origin) => ({ origin, path: copyPath(origin, relativePath) })),
  }));
}
