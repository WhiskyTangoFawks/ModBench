import type { FileOrigin, OriginFile } from '../instanceLoader/instance';
import { foldPath } from '../instanceLoader/fileConflictIndex';
import type { FileToCompare } from './sameCopies';
import { present } from '../ports/present';

type CopyFile = Pick<OriginFile, 'relativePath' | 'sourcePath'>;

interface CopiesIn {
  readonly files: { get(relativePath: string): { readonly providers: readonly FileOrigin[] } | undefined };
  readonly filesByMod: ReadonlyMap<string, readonly CopyFile[]>;
  readonly overwriteFiles: readonly CopyFile[];
}

export function copiesToRead(value: CopiesIn, relativePaths: readonly string[]): FileToCompare[] {
  const byOrigin = new Map<string, ReadonlyMap<string, string>>();
  const copyPath = (origin: FileOrigin, relativePath: string): string => {
    const key = origin.kind === 'mod' ? `mod/${origin.name}` : origin.kind;
    let paths = byOrigin.get(key);
    if (paths === undefined) {
      const files = origin.kind === 'mod' ? value.filesByMod.get(origin.name) ?? [] : value.overwriteFiles;
      paths = new Map(files.map((file) => [foldPath(file.relativePath), file.sourcePath]));
      byOrigin.set(key, paths);
    }
    return present(paths.get(foldPath(relativePath)), `${key}'s copy of ${relativePath}`);
  };
  return relativePaths.map((relativePath) => ({
    relativePath,
    providers: (value.files.get(relativePath)?.providers ?? []).map((origin) => ({ origin, path: copyPath(origin, relativePath) })),
  }));
}
