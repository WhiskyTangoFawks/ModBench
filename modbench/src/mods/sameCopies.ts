import type { FileOrigin } from '../instanceLoader/instance';
import type { FileRead, FileStamp, InstanceAdapter } from '../instanceAdapter/instanceAdapter';

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

export interface FileToCompare {
  readonly relativePath: string;
  readonly providers: readonly { readonly origin: FileOrigin; readonly path: string }[];
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

export type CopyReads = Pick<InstanceAdapter, 'fileStamp' | 'originFileHash'>;

async function contentsOf(adapter: CopyReads, path: string, stamp: FileRead<FileStamp>, sizes: readonly bigint[]): Promise<Contents> {
  if (stamp.kind === 'unreadable') return stamp;
  const { answer } = stamp;
  if (sizes.filter((size) => size === answer.size).length === 1) return { kind: 'ownSize' };
  const hashed = await adapter.originFileHash(path);
  return hashed.kind === 'read' ? { kind: 'read', answer: hashed.answer.hash } : hashed;
}

export function sameCopies(adapter: CopyReads, files: readonly FileToCompare[]): Promise<FileCopies[]> {
  return Promise.all(files.map(async ({ relativePath, providers }) => {
    const stamped = await Promise.all(providers.map(async ({ origin, path }) => ({ origin, path, stamp: await adapter.fileStamp(path) })));
    const sizes = stamped.flatMap(({ stamp }) => (stamp.kind === 'read' ? [stamp.answer.size] : []));
    const contents = await Promise.all(stamped.map(async ({ origin, path, stamp }) =>
      ({ origin, stamp, contents: await contentsOf(adapter, path, stamp, sizes) })));
    return { relativePath, copies: numbered(contents) };
  }));
}
