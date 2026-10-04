import type { FileOrigin, FileRead, FileStamp, InstanceAdapter, OriginFile } from '../instanceAdapter/instanceAdapter';
import { present } from '../ports/present';
import { foldPath } from './fileConflictIndex';

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

// A file system stamps a change with a clock coarser than a digest is quick, and a network share's
// clock is not this machine's: a stamp this recent may not change for a write that follows it.
const SETTLED_AFTER_MS = 2_000;

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;

const settledBefore = (stamp: FileStamp, readFromMs: number): boolean =>
  stamp.changedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n;

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

export class SameCopies {
  private readonly remembered = new Map<string, { readonly stamp: FileStamp; readonly digest: Promise<FileRead<string>> }>();

  constructor(private readonly adapter: Pick<InstanceAdapter, 'fileStamp' | 'contentDigest'>) {}

  of(value: CopiesIn, relativePaths: readonly string[]): Promise<FileCopies[]> {
    this.forgetCopiesNotIn(value);
    const copyPath = copyPathsIn(value);
    return Promise.all(relativePaths.map(async (relativePath) => {
      const stamped = await Promise.all((value.files.get(relativePath)?.providers ?? []).map(async (origin) => {
        const path = copyPath(origin, relativePath);
        return { origin, path, stamp: await this.adapter.fileStamp(path) };
      }));
      const sizes = stamped.flatMap(({ stamp }) => (stamp.kind === 'read' ? [stamp.answer.size] : []));
      const contents = await Promise.all(stamped.map(async ({ origin, path, stamp }) =>
        ({ origin, stamp, contents: await this.contentsOf(path, stamp, sizes) })));
      return { relativePath, copies: numbered(contents) };
    }));
  }

  private forgetCopiesNotIn(value: CopiesIn): void {
    const copies = new Set([...value.filesByMod.values()].flat().concat(value.overwriteFiles).map((file) => file.sourcePath));
    for (const path of this.remembered.keys()) if (!copies.has(path)) this.remembered.delete(path);
  }

  private async contentsOf(path: string, stamp: FileRead<FileStamp>, sizes: readonly bigint[]): Promise<Contents> {
    if (stamp.kind === 'unreadable') return stamp;
    const { answer } = stamp;
    if (sizes.filter((size) => size === answer.size).length === 1) return { kind: 'ownSize' };
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
