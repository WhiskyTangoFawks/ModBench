import type { FileOrigin, InstanceValue } from '../instanceLoader/instance';
import type { StackedFile } from '../instanceLoader/fileConflictIndex';

/** The files an origin holds. */
export const filesOfOrigin = <File>(
  value: { readonly filesByMod: ReadonlyMap<string, readonly File[]>; readonly overwriteFiles: readonly File[] }, origin: FileOrigin,
): readonly File[] => (origin.kind === 'mod' ? value.filesByMod.get(origin.name) ?? [] : value.overwriteFiles);

/** Each file by the path it is asked by, with its copies as the game stacks them. */
export const copiesToRead = (value: Pick<InstanceValue, 'stackedCopies'>, relativePaths: readonly string[]): StackedFile[] =>
  relativePaths.map((relativePath) => ({ relativePath, copies: value.stackedCopies.get(relativePath)?.copies ?? [] }));
