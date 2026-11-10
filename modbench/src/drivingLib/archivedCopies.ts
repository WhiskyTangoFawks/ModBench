// mods-conflicts.md, Cells: a copy in an archive, read as a loose copy is: its size, its date modified (its archive's) and
// its hash.

import { foldPath, type ArchivedFileAddress } from '../instanceLoader/fileConflictIndex';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';

export type FileRead<T> = { readonly kind: 'read'; readonly answer: T } | { readonly kind: 'unreadable'; readonly reason: string };
export interface FileStamp { readonly size: bigint; readonly modifiedNs: bigint }

export interface ArchiveCopyReader {
  getArchiveCopies(gameRelease: string, archive: string, files: readonly string[]): Promise<readonly { file: string; size: number; hash: string }[] | ReadFailed>;
}

export type ArchivedCopyRead = FileRead<FileStamp & { readonly hash: string }>;

interface Held {
  readonly stamp: string;
  readonly copies: Map<string, { readonly size: bigint; readonly hash: string }>;
}

/** Holds what mEdit answered for each file of an archive while the archive's stamp is the one it had. */
export class ArchivedCopies {
  private readonly held = new Map<string, Held>();

  constructor(private readonly reader: ArchiveCopyReader, private readonly stampOf: (path: string) => Promise<FileRead<FileStamp>>) {}

  /** Each address's copy, in the order asked, each archive asked once for the files it has not answered. */
  async read(addresses: readonly ArchivedFileAddress[]): Promise<ArchivedCopyRead[]> {
    const byArchive = new Map<string, ArchivedFileAddress[]>();
    for (const address of addresses) byArchive.set(address.archive, [...byArchive.get(address.archive) ?? [], address]);
    const reads = new Map(await Promise.all([...byArchive].map(async ([archive, asked]) => [archive, await this.readArchive(archive, asked)] as const)));
    return addresses.map(({ archive, file }) => reads.get(archive)?.(file) ?? { kind: 'unreadable', reason: `${archive} was not read.` });
  }

  private async readArchive(archive: string, asked: readonly ArchivedFileAddress[]): Promise<(file: string) => ArchivedCopyRead> {
    const stamp = await this.stampOf(archive);
    if (stamp.kind === 'unreadable') return () => stamp;
    const { size, modifiedNs } = stamp.answer;
    const key = `${size}/${modifiedNs}`;
    const kept = this.held.get(archive);
    const held: Held = kept?.stamp === key ? kept : { stamp: key, copies: new Map() };
    this.held.set(archive, held);
    const missing = [...new Map(asked.map(({ file }) => [foldPath(file), file])).entries()].filter(([folded]) => !held.copies.has(folded)).map(([, file]) => file);
    const answered = missing.length === 0 || asked[0] === undefined ? [] : await this.reader.getArchiveCopies(asked[0].gameRelease, archive, missing);
    const failed = isReadFailed(answered) ? failureReason(answered) : undefined;
    if (!isReadFailed(answered)) for (const copy of answered) held.copies.set(foldPath(copy.file), { size: BigInt(copy.size), hash: copy.hash });
    return (file) => {
      const copy = held.copies.get(foldPath(file));
      if (copy !== undefined) return { kind: 'read', answer: { ...copy, modifiedNs } };
      return { kind: 'unreadable', reason: failed ?? `${archive} does not hold ${file}.` };
    };
  }
}
