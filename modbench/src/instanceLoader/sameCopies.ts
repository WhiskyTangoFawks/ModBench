// Which copies of a file are the same: sizes first, then the content digest of each copy whose size
// another copy shares, remembered by the copy's stamp.

import type { FileOrigin, FileRead, FileStamp, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { present } from '../ports/present';
import { foldPath } from './fileConflictIndex';
import type { InstanceValue } from './instance';

/** One provider's copy of a file. Two copies of one file with the same `contents` hold the same
 *  bytes. */
export type Copy = { readonly origin: FileOrigin } & (
  | { readonly kind: 'read'; readonly contents: number }
  | { readonly kind: 'unreadable'; readonly reason: string });

export interface FileCopies {
  readonly relativePath: string;
  /** Each provider's copy, winning-most first. */
  readonly copies: readonly Copy[];
}

type CopiesIn = Pick<InstanceValue, 'files' | 'filesByMod' | 'overwriteFiles'>;

// A file system stamps a change with a clock coarser than a digest is quick, and a network share's
// clock is not this machine's: a stamp this recent may not change for a write that follows it.
const SETTLED_AFTER_MS = 2_000;

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;

const settledBefore = (stamp: FileStamp, readFromMs: number): boolean =>
  stamp.changedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n;

// Each origin's files are looked up by folded path, built once per origin an answer needs.
function copyPathsIn(value: CopiesIn): (origin: FileOrigin, relativePath: string) => string {
  const byOrigin = new Map<string, ReadonlyMap<string, string>>();
  return (origin, relativePath) => {
    const key = origin.kind === 'mod' ? `mod/${origin.name}` : origin.kind;
    let paths = byOrigin.get(key);
    if (paths === undefined) {
      const files = origin.kind === 'mod' ? value.filesByMod.get(origin.name) ?? [] : value.overwriteFiles;
      paths = new Map(files.map((file) => [foldPath(file.relativePath), file.absolutePath]));
      byOrigin.set(key, paths);
    }
    return present(paths.get(foldPath(relativePath)), `${key}'s copy of ${relativePath}`);
  };
}

// A digest names the contents; a copy whose size no other copy shares has contents of its own.
type Contents = FileRead<string | undefined>;

function numbered(contents: readonly { readonly origin: FileOrigin; readonly contents: Contents }[]): Copy[] {
  const numbers = new Map<string, number>();
  let next = 0;
  return contents.map(({ origin, contents: read }) => {
    if (read.kind === 'unreadable') return { origin, kind: 'unreadable', reason: read.reason };
    const digest = read.answer;
    const known = digest === undefined ? undefined : numbers.get(digest);
    if (known !== undefined) return { origin, kind: 'read', contents: known };
    if (digest !== undefined) numbers.set(digest, next);
    return { origin, kind: 'read', contents: next++ };
  });
}

export class SameCopies {
  // By the path a copy is read from; an answer still being read is shared, never read twice.
  private readonly remembered = new Map<string, { readonly stamp: FileStamp; readonly digest: Promise<FileRead<string>> }>();

  constructor(private readonly adapter: Pick<InstanceAdapter, 'fileStamp' | 'contentDigest'>) {}

  of(value: CopiesIn, relativePaths: readonly string[]): Promise<FileCopies[]> {
    const copyPath = copyPathsIn(value);
    return Promise.all(relativePaths.map(async (relativePath) => {
      const stamped = await Promise.all((value.files.get(relativePath)?.providers ?? []).map(async (origin) => {
        const path = copyPath(origin, relativePath);
        return { origin, path, stamp: await this.adapter.fileStamp(path) };
      }));
      const sizes = stamped.flatMap(({ stamp }) => (stamp.kind === 'read' ? [stamp.answer.size] : []));
      const contents = await Promise.all(stamped.map(async ({ origin, path, stamp }) =>
        ({ origin, contents: await this.contentsOf(path, stamp, sizes) })));
      return { relativePath, copies: numbered(contents) };
    }));
  }

  private async contentsOf(path: string, stamp: FileRead<FileStamp>, sizes: readonly bigint[]): Promise<Contents> {
    if (stamp.kind === 'unreadable') return stamp;
    const { answer } = stamp;
    if (sizes.filter((size) => size === answer.size).length === 1) return { kind: 'read', answer: undefined };
    return this.digestOf(path, answer);
  }

  private digestOf(path: string, stamp: FileStamp): Promise<FileRead<string>> {
    const known = this.remembered.get(path);
    if (known !== undefined && sameStamp(known.stamp, stamp)) return known.digest;
    const readFromMs = Date.now();
    const entry = { stamp, digest: this.adapter.contentDigest(path) };
    this.remembered.set(path, entry);
    void entry.digest.then((read) => {
      if ((read.kind === 'unreadable' || !settledBefore(stamp, readFromMs)) && this.remembered.get(path) === entry) {
        this.remembered.delete(path);
      }
    });
    return entry.digest;
  }
}
