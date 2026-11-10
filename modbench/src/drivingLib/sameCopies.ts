import type { FileOrigin } from '../instanceLoader/instance';
import type { ArchivedFileAddress, StackedCopy, StackedFile } from '../instanceLoader/fileConflictIndex';
import type { ArchivedCopies, ArchivedCopyRead, FileRead, FileStamp } from './archivedCopies';

/** One provider's copy of a file. Two copies of one file with the same `sameAs` hold the same
 *  bytes. */
export type Copy = { readonly origin: FileOrigin } & (
  | { readonly kind: 'read'; readonly sameAs: number; readonly size: bigint; readonly modifiedNs: bigint }
  | { readonly kind: 'unreadable'; readonly reason: string });

export const modifiedMs = (copy: { readonly modifiedNs: bigint }): number => Number(copy.modifiedNs / 1_000_000n);

export interface FileCopies {
  readonly relativePath: string;
  /** Each provider's copy, winning-most first. */
  readonly copies: readonly Copy[];
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

export interface CopyReads {
  fileStamp(path: string): Promise<FileRead<FileStamp>>;
  originFileHash(path: string): Promise<FileRead<{ readonly hash: string }>>;
}

async function contentsOf(adapter: CopyReads, path: string, stamp: FileRead<FileStamp>, sizes: readonly bigint[]): Promise<Contents> {
  if (stamp.kind === 'unreadable') return stamp;
  const { answer } = stamp;
  if (sizes.filter((size) => size === answer.size).length === 1) return { kind: 'ownSize' };
  const hashed = await adapter.originFileHash(path);
  return hashed.kind === 'read' ? { kind: 'read', answer: hashed.answer.hash } : hashed;
}

/** A file whose copies are compared. */
export type FileToCompare = Pick<StackedFile, 'relativePath' | 'copies'>;

type StampedCopy = { readonly origin: FileOrigin } & (
  | { readonly kind: 'loose'; readonly path: string; readonly stamp: FileRead<FileStamp> }
  | { readonly kind: 'archived'; readonly stamp: ArchivedCopyRead });

// An archived copy is read with its hash, so only a loose copy is read again for its contents.
function contentsOfCopy(adapter: CopyReads, copy: StampedCopy, sizes: readonly bigint[]): Promise<Contents> {
  if (copy.kind === 'loose') return contentsOf(adapter, copy.path, copy.stamp, sizes);
  return Promise.resolve(copy.stamp.kind === 'read' ? { kind: 'read', answer: copy.stamp.answer.hash } : copy.stamp);
}

export async function sameCopies(adapter: CopyReads, archived: Pick<ArchivedCopies, 'read'>, files: readonly FileToCompare[]): Promise<FileCopies[]> {
  const addresses = files.flatMap(({ copies }) => copies.flatMap(({ at }): ArchivedFileAddress[] => (at.kind === 'archived' ? [at] : [])));
  const archivedReads = await archived.read(addresses);
  const archivedRead = new Map(addresses.map((address, index) => [address, archivedReads[index]] as const));
  const stamped = async ({ origin, at }: StackedCopy): Promise<StampedCopy> => {
    if (at.kind === 'loose') return { origin, kind: 'loose', path: at.path, stamp: await adapter.fileStamp(at.path) };
    return { origin, kind: 'archived', stamp: archivedRead.get(at) ?? { kind: 'unreadable', reason: `${at.archive} was not read.` } };
  };
  return Promise.all(files.map(async ({ relativePath, copies }) => {
    const stamps = await Promise.all(copies.map(stamped));
    const sizes = stamps.flatMap(({ stamp }) => (stamp.kind === 'read' ? [stamp.answer.size] : []));
    const contents = await Promise.all(stamps.map(async (copy) => ({ origin: copy.origin, stamp: copy.stamp, contents: await contentsOfCopy(adapter, copy, sizes) })));
    return { relativePath, copies: numbered(contents) };
  }));
}
