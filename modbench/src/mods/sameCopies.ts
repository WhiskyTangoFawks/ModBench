import type { FileOrigin, FileRead, FileStamp, InstanceAdapter, OriginFile } from '../instanceAdapter/instanceAdapter';
import { present } from '../ports/present';
import { foldPath } from '../instanceLoader/fileConflictIndex';

/** One provider's copy of a file. Two copies of one file with the same `sameAs` hold the same
 *  bytes. */
export type Copy = { readonly origin: FileOrigin } & (
  | { readonly kind: 'read'; readonly sameAs: number; readonly size: bigint; readonly modifiedNs: bigint }
  | { readonly kind: 'unreadable'; readonly reason: string });

export interface FileCopies {
  readonly relativePath: string;
  /** Each provider's copy, winning-most first. */
  readonly copies: readonly Copy[];
}

type CopyFile = Pick<OriginFile, 'relativePath' | 'sourcePath'>;

export interface CopiesIn {
  readonly files: { get(relativePath: string): { readonly providers: readonly FileOrigin[] } | undefined };
  readonly filesByMod: ReadonlyMap<string, readonly CopyFile[]>;
  readonly overwriteFiles: readonly CopyFile[];
}

function copyPathsIn(value: CopiesIn): (origin: FileOrigin, relativePath: string) => string {
  const byOrigin = new Map<string, ReadonlyMap<string, string>>();
  return (origin, relativePath) => {
    const key = origin.kind === 'mod' ? `mod/${origin.name}` : origin.kind;
    let paths = byOrigin.get(key);
    if (paths === undefined) {
      const files = origin.kind === 'mod' ? value.filesByMod.get(origin.name) ?? [] : value.overwriteFiles;
      paths = new Map(files.map((file) => [foldPath(file.relativePath), file.sourcePath]));
      byOrigin.set(key, paths);
    }
    return present(paths.get(foldPath(relativePath)), `${key}'s copy of ${relativePath}`);
  };
}

type Contents = FileRead<string> | { readonly kind: 'ownSize' };

interface Stamped {
  readonly origin: FileOrigin;
  readonly stamp: FileRead<FileStamp>;
  readonly contents: Contents;
}

function numbered(copies: readonly Stamped[]): Copy[] {
  const numbers = new Map<string, number>();
  let next = 0;
  return copies.map(({ origin, stamp, contents }) => {
    if (contents.kind === 'unreadable') return { origin, kind: 'unreadable', reason: contents.reason };
    if (stamp.kind === 'unreadable') return { origin, kind: 'unreadable', reason: stamp.reason };
    const { size, modifiedNs } = stamp.answer;
    if (contents.kind === 'ownSize') return { origin, kind: 'read', sameAs: next++, size, modifiedNs };
    const known = numbers.get(contents.answer);
    if (known !== undefined) return { origin, kind: 'read', sameAs: known, size, modifiedNs };
    numbers.set(contents.answer, next);
    return { origin, kind: 'read', sameAs: next++, size, modifiedNs };
  });
}

type CopyReads = Pick<InstanceAdapter, 'fileStamp' | 'originFileHash'>;

async function contentsOf(adapter: CopyReads, path: string, stamp: FileRead<FileStamp>, sizes: readonly bigint[]): Promise<Contents> {
  if (stamp.kind === 'unreadable') return stamp;
  const { answer } = stamp;
  if (sizes.filter((size) => size === answer.size).length === 1) return { kind: 'ownSize' };
  const hashed = await adapter.originFileHash(path);
  return hashed.kind === 'read' ? { kind: 'read', answer: hashed.answer.hash } : hashed;
}

/** For each of `relativePaths`, which of its providers' copies in `value` hold the same bytes, sizes first. */
export function sameCopies(adapter: CopyReads, value: CopiesIn, relativePaths: readonly string[]): Promise<FileCopies[]> {
  const copyPath = copyPathsIn(value);
  return Promise.all(relativePaths.map(async (relativePath) => {
    const stamped = await Promise.all((value.files.get(relativePath)?.providers ?? []).map(async (origin) => {
      const path = copyPath(origin, relativePath);
      return { origin, path, stamp: await adapter.fileStamp(path) };
    }));
    const sizes = stamped.flatMap(({ stamp }) => (stamp.kind === 'read' ? [stamp.answer.size] : []));
    const contents = await Promise.all(stamped.map(async ({ origin, path, stamp }) =>
      ({ origin, stamp, contents: await contentsOf(adapter, path, stamp, sizes) })));
    return { relativePath, copies: numbered(contents) };
  }));
}
