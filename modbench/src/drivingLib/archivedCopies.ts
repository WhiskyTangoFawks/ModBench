// mods-conflicts.md, Cells: a copy in an archive, read as a loose copy is: its size, its date modified (its archive's), and
// its hash when another copy shares its size.

import { foldPath, type ArchivedFileAddress } from '../instanceLoader/fileConflictIndex';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import type { components } from '../wire/generated/api';

export type FileRead<T> = { readonly kind: 'read'; readonly answer: T } | { readonly kind: 'unreadable'; readonly reason: string };
export interface FileStamp { readonly size: bigint; readonly modifiedNs: bigint }

export interface ArchiveCopyReader {
  getArchiveCopies(gameRelease: string, archive: string, files: readonly string[], hashed: boolean): Promise<components['schemas']['ArchivedCopy'][] | ReadFailed>;
}

/** The most bytes one read of hashes decompresses, so each read answers well within mEdit's time to answer. */
export const HASH_BATCH_BYTES = 64 * 1024 * 1024;

interface Held {
  readonly stamp: string;
  readonly modifiedNs: bigint;
  readonly sizes: Map<string, bigint>;
  readonly hashes: Map<string, string>;
}

type Answered<T> = (file: string) => FileRead<T>;

const byArchive = (addresses: readonly ArchivedFileAddress[]): Map<string, ArchivedFileAddress[]> => {
  const grouped = new Map<string, ArchivedFileAddress[]>();
  for (const address of addresses) grouped.set(address.archive, [...grouped.get(address.archive) ?? [], address]);
  return grouped;
};

// Each file once, by its spelling first asked.
const filesOf = (asked: readonly ArchivedFileAddress[]): string[] => [...new Map(asked.map(({ file }) => [foldPath(file), file])).values()];

/** Holds what mEdit answered for each file of an archive while the archive's stamp is the one it had. */
export class ArchivedCopies {
  private readonly held = new Map<string, Held>();

  constructor(private readonly reader: ArchiveCopyReader, private readonly stampOf: (path: string) => Promise<FileRead<FileStamp>>) {}

  /** Each address's size and its archive's date modified, in the order asked; no file's bytes are read. */
  stamps(addresses: readonly ArchivedFileAddress[]): Promise<FileRead<FileStamp>[]> {
    return this.answer(addresses, async (held, asked) => {
      const missing = filesOf(asked).filter((file) => !held.sizes.has(foldPath(file)));
      const failed = missing.length === 0 ? undefined : await this.ask(held, asked, missing, false);
      return (file) => {
        const size = held.sizes.get(foldPath(file));
        return size === undefined ? { kind: 'unreadable', reason: failed ?? `${asked[0]?.archive} does not hold ${file}.` } : { kind: 'read', answer: { size, modifiedNs: held.modifiedNs } };
      };
    });
  }

  /** Each address's hash, in the order asked, its bytes read in batches of at most `HASH_BATCH_BYTES`. */
  hashes(addresses: readonly ArchivedFileAddress[]): Promise<FileRead<string>[]> {
    return this.answer(addresses, async (held, asked) => {
      const failures = new Map<string, string>();
      let batch: string[] = [];
      let bytes = 0n;
      const flush = async () => {
        const failed = batch.length === 0 ? undefined : await this.ask(held, asked, batch, true);
        if (failed !== undefined) for (const file of batch) failures.set(foldPath(file), failed);
        batch = [];
        bytes = 0n;
      };
      for (const file of filesOf(asked).filter((one) => !held.hashes.has(foldPath(one)))) {
        const size = held.sizes.get(foldPath(file)) ?? 0n;
        if (batch.length > 0 && bytes + size > BigInt(HASH_BATCH_BYTES)) await flush();
        batch.push(file);
        bytes += size;
      }
      await flush();
      return (file) => {
        const hash = held.hashes.get(foldPath(file));
        return hash === undefined ? { kind: 'unreadable', reason: failures.get(foldPath(file)) ?? `${asked[0]?.archive} does not hold ${file}.` } : { kind: 'read', answer: hash };
      };
    });
  }

  private async answer<T>(addresses: readonly ArchivedFileAddress[], read: (held: Held, asked: readonly ArchivedFileAddress[]) => Promise<Answered<T>>): Promise<FileRead<T>[]> {
    const reads = new Map(await Promise.all([...byArchive(addresses)].map(async ([archive, asked]) => {
      const held = await this.heldAt(archive);
      return [archive, 'reason' in held ? (): FileRead<T> => held : await read(held, asked)] as const;
    })));
    return addresses.map(({ archive, file }) => reads.get(archive)?.(file) ?? { kind: 'unreadable', reason: `${archive} was not read.` });
  }

  private async heldAt(archive: string): Promise<Held | { readonly kind: 'unreadable'; readonly reason: string }> {
    const stamp = await this.stampOf(archive);
    if (stamp.kind === 'unreadable') return stamp;
    const { size, modifiedNs } = stamp.answer;
    const key = `${size}/${modifiedNs}`;
    const kept = this.held.get(archive);
    const held = kept?.stamp === key ? kept : { stamp: key, modifiedNs, sizes: new Map(), hashes: new Map() };
    this.held.set(archive, held);
    return held;
  }

  // Why the files could not be read, or undefined once their answers are held.
  private async ask(held: Held, asked: readonly ArchivedFileAddress[], files: readonly string[], hashed: boolean): Promise<string | undefined> {
    const [first] = asked;
    if (first === undefined) return undefined;
    const answered = await this.reader.getArchiveCopies(first.gameRelease, first.archive, files, hashed);
    if (isReadFailed(answered)) return failureReason(answered);
    for (const { file, size, hash } of answered) {
      held.sizes.set(foldPath(file), BigInt(size));
      if (typeof hash === 'string') held.hashes.set(foldPath(file), hash);
    }
    return undefined;
  }
}
