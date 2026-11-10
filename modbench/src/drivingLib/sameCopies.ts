import type { FileOrigin } from '../instanceLoader/instance';
import type { ArchivedFileAddress, CopyAt, StackedCopy, StackedFile } from '../instanceLoader/fileConflictIndex';
import type { ArchivedCopies, FileRead, FileStamp } from './archivedCopies';
import { present } from '../ports/present';

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

/** A file whose copies are compared. */
export type FileToCompare = Pick<StackedFile, 'relativePath' | 'copies'>;

interface StampedCopy {
  readonly copy: StackedCopy;
  readonly stamp: FileRead<FileStamp>;
}

const sizesOf = (copies: readonly StampedCopy[]): bigint[] => copies.flatMap(({ stamp }) => (stamp.kind === 'read' ? [stamp.answer.size] : []));

const sharesSize = (stamp: FileRead<FileStamp>, sizes: readonly bigint[]): boolean =>
  stamp.kind === 'read' && sizes.filter((size) => size === stamp.answer.size).length > 1;

async function readEach<T>(addresses: readonly ArchivedFileAddress[], read: (addresses: readonly ArchivedFileAddress[]) => Promise<FileRead<T>[]>): Promise<Map<ArchivedFileAddress, FileRead<T>>> {
  const reads = await read(addresses);
  return new Map(addresses.map((address, index) => [address, present(reads[index], `the read of ${address.file} in ${address.archive}`)]));
}

async function contentsOf(
  adapter: CopyReads, { copy: { at }, stamp }: StampedCopy, sizes: readonly bigint[], archivedHashes: ReadonlyMap<ArchivedFileAddress, FileRead<string>>,
): Promise<Contents> {
  if (stamp.kind === 'unreadable') return stamp;
  if (!sharesSize(stamp, sizes)) return { kind: 'ownSize' };
  if (at.kind === 'archived') return present(archivedHashes.get(at), `the hash of ${at.file} in ${at.archive}`);
  const hashed = await adapter.originFileHash(at.path);
  return hashed.kind === 'read' ? { kind: 'read', answer: hashed.answer.hash } : hashed;
}

export async function sameCopies(adapter: CopyReads, archived: Pick<ArchivedCopies, 'stamps' | 'hashes'>, files: readonly FileToCompare[]): Promise<FileCopies[]> {
  const archivedIn = (copies: readonly { readonly at: CopyAt }[]): ArchivedFileAddress[] => copies.flatMap(({ at }) => (at.kind === 'archived' ? [at] : []));
  const archivedStamps = await readEach(files.flatMap(({ copies }) => archivedIn(copies)), (addresses) => archived.stamps(addresses));
  const stamped = await Promise.all(files.map(async ({ relativePath, copies }) => ({
    relativePath,
    copies: await Promise.all(copies.map(async (copy): Promise<StampedCopy> => ({
      copy, stamp: copy.at.kind === 'loose' ? await adapter.fileStamp(copy.at.path) : present(archivedStamps.get(copy.at), `the stamp of ${copy.at.file} in ${copy.at.archive}`),
    }))),
  })));
  const toHash = stamped.flatMap(({ copies }) => archivedIn(copies.filter(({ stamp }) => sharesSize(stamp, sizesOf(copies))).map(({ copy }) => copy)));
  const archivedHashes = await readEach(toHash, (addresses) => archived.hashes(addresses));
  return Promise.all(stamped.map(async ({ relativePath, copies }) => {
    const sizes = sizesOf(copies);
    const contents = await Promise.all(copies.map(async (one) => ({ origin: one.copy.origin, stamp: one.stamp, contents: await contentsOf(adapter, one, sizes, archivedHashes) })));
    return { relativePath, copies: numbered(contents) };
  }));
}
