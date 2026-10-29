// The hashes the adapter keeps in its index (ADR-0013): downloaded, game and origin files', each trusted while its file's
// stamp is the one it was hashed at, and each downloaded file's entries under its hash.

import { join } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import type { FileProblems } from '../../ports/fileProblems';
import type { InstallationFileReader } from './installationFileReader';
import { digestOf } from './contentDigest';
import { append, ensureDir, get, listDir, makeTempDir, readOrReason, remove, stampOf, withLock } from '../files';
import type { FileRead, FileStamp, HashedDownloadedFile, HashedFile, InstanceAdapter } from '../instanceAdapter';

const INDEX_FILE = 'hashes.jsonl';
const EXTRACTION_PREFIX = 'entries-';

// A file system stamps a change with a clock coarser than a hash is quick, and a network share's
// clock is not this machine's: a stamp this recent may not change for a write that follows it.
const SETTLED_AFTER_MS = 2_000;

type Kind = 'origin' | 'game' | 'downloadedFile';
type LineKind = Kind | 'package';

interface Kept {
  readonly stamp: FileStamp;
  readonly hashed: Promise<FileRead<HashedDownloadedFile>>;
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;

const settledBefore = (stamp: FileStamp, readFromMs: number): boolean =>
  stamp.changedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n;

const lineOf = (kind: LineKind, path: string, stamp: FileStamp, hashed: HashedDownloadedFile): string =>
  `${JSON.stringify([kind, path, String(stamp.size), String(stamp.modifiedNs), String(stamp.changedNs), hashed.hash, ...hashed.entries.flatMap((entry) => [entry.path, entry.hash])])}\n`;

type Line = [LineKind, string, string, string, string, string, ...string[]];

const isLine = (fields: unknown): fields is Line =>
  Array.isArray(fields) && fields.length >= 6 && fields.length % 2 === 0 && fields.every((field) => typeof field === 'string')
  && (fields[0] === 'origin' || fields[0] === 'game' || fields[0] === 'downloadedFile' || fields[0] === 'package');

function keptAt(line: string): { kind: LineKind; path: string; stamp: FileStamp; read: FileRead<HashedDownloadedFile> } | undefined {
  try {
    const fields: unknown = JSON.parse(line);
    if (!isLine(fields)) return undefined;
    const [tag, path, size, modifiedNs, changedNs, hash, ...entries] = fields;
    const stamp = { size: BigInt(size), modifiedNs: BigInt(modifiedNs), changedNs: BigInt(changedNs) };
    const pairs = entries.flatMap((entryPath, i) => (i % 2 === 0 ? [{ path: entryPath, hash: entries[i + 1] ?? '' }] : []));
    return { kind: tag, path, stamp, read: { kind: 'read', answer: { size: Number(stamp.size), hash, entries: pairs } } };
  } catch {
    return undefined;
  }
}

// An extraction is a whole installation file, so one a crash left behind would hold its space for good.
async function removeLeftoverExtractions(folder: string): Promise<void> {
  const names = await listDir(folder).catch(() => []);
  await Promise.all(names.filter((name) => name.name.startsWith(EXTRACTION_PREFIX)).map((name) => remove(join(folder, name.name))));
}

// One extracts over the other wherever names ignore case, so the survivor's hash would stand for both.
function refuseCaseCollisions(entries: readonly string[]): void {
  const byFolded = new Map<string, string>();
  for (const entry of entries) {
    const other = byFolded.get(entry.toLowerCase());
    if (other !== undefined) throw new Error(`Its entries ${other} and ${entry} differ only by case, so one extracts over the other.`);
    byFolded.set(entry.toLowerCase(), entry);
  }
}

interface DownloadedFilesHashed {
  readonly files: readonly (HashedDownloadedFile & { readonly path: string })[];
  readonly notes: readonly string[];
}

/** The adapter's hashes, its index in `folder`, which it alone writes; a downloaded file's entries are hashed from
 *  its extraction there. */
export interface HashIndex extends Pick<InstanceAdapter, 'originFileHash' | 'packageEntries' | 'keepPackageEntries'> {
  /** A game file's size and hash, the hash as mEdit's manifest carries it, kept in the record index (ADR-0013). */
  gameFileHash(path: string): Promise<FileRead<HashedFile>>;
  /** The size and hash of the downloaded file at `path`, and of each of its entries, kept in the hash index. */
  downloadedFileHash(path: string): Promise<FileRead<HashedDownloadedFile>>;
  /** Keeps `entries`, each package path's hash, under the hash of a game folder package a manifest pins, so a status reads
   *  them in this session and the next; answers why they could not be written, if so. */
  keepPackageEntries(hash: string, entries: ReadonlyMap<string, string>): Promise<string | undefined>;
  /** As `downloadedFileHash`, each downloaded file at `paths`, and why any could not be read, as
   *  `InstanceAdapter.downloadedFilesHashed` answers them. */
  downloadedFilesHashed(paths: readonly string[], options?: Parameters<InstanceAdapter['downloadedFilesHashed']>[0]): Promise<DownloadedFilesHashed>;
}

export function hashIndex(folder: string, installationFileReader: InstallationFileReader, problems: FileProblems): HashIndex {
  const indexFile = join(folder, INDEX_FILE);
  const kept: Record<Kind, Map<string, Kept>> = { origin: new Map(), game: new Map(), downloadedFile: new Map() };
  const entriesByHash = new Map<string, ReadonlyMap<string, string>>();
  let loaded: Promise<void> | undefined;
  let unwritten: string | undefined;

  // A hash fixes a downloaded file's bytes, so its entries stay true after the file is gone or another takes its path.
  const keepEntries = (kind: Kind, read: FileRead<HashedDownloadedFile>): void => {
    if (kind === 'downloadedFile' && read.kind === 'read') entriesByHash.set(read.answer.hash, new Map(read.answer.entries.map(({ path, hash }) => [path, hash])));
  };

  // The record index only spares a read: one that cannot be read or written costs a read again, never a wrong hash.
  const load = (): Promise<void> => (loaded ??= removeLeftoverExtractions(folder).then(() => get(indexFile, '')).then((text) => {
    for (const line of text.split('\n')) {
      const known = keptAt(line);
      if (known === undefined) continue;
      if (known.kind === 'package') {
        if (known.read.kind === 'read') entriesByHash.set(known.path, new Map(known.read.answer.entries.map(({ path, hash }) => [path, hash])));
        continue;
      }
      kept[known.kind].set(known.path, { stamp: known.stamp, hashed: Promise.resolve(known.read) });
      keepEntries(known.kind, known.read);
    }
  }, () => undefined));

  const hashedAlone = async (path: string, stamp: FileStamp): Promise<HashedDownloadedFile> =>
    ({ size: Number(stamp.size), hash: await digestOf(path), entries: [] });

  // One extraction at a time: each is a whole installation file on disk.
  const hashedWithEntries = (path: string, stamp: FileStamp): Promise<HashedDownloadedFile> => withLock(join(folder, EXTRACTION_PREFIX), async () => {
    const listed = await installationFileReader.list(path);
    refuseCaseCollisions(listed);
    await ensureDir(folder);
    const extraction = await makeTempDir(join(folder, EXTRACTION_PREFIX));
    try {
      await installationFileReader.extract(path, extraction);
      const entries = [];
      for (const entry of listed) entries.push({ path: entry, hash: await digestOf(join(extraction, entry)) });
      return { ...(await hashedAlone(path, stamp)), entries };
    } finally {
      await remove(extraction);
    }
  });

  // Kept so for the session, as hashing it again costs a whole extraction to fail again (modlist-repository.md, Update manifest, story 10).

  async function keep(kind: Kind, path: string, entry: Kept, read: FileRead<HashedDownloadedFile>, readFromMs: number): Promise<void> {
    if (kept[kind].get(path) !== entry) return;
    if ((read.kind === 'unreadable' && kind !== 'downloadedFile') || !settledBefore(entry.stamp, readFromMs)) {
      kept[kind].delete(path);
      return;
    }
    if (read.kind === 'unreadable') return;
    await ensureDir(folder).then(() => append(indexFile, lineOf(kind, path, entry.stamp, read.answer))).catch((err: unknown) => { unwritten = errorMessage(err); });
  }

  const shown = (path: string, read: FileRead<unknown>): void => {
    problems.set(path, read.kind === 'read' ? [] : [{ line: 1, message: `could not be hashed: ${read.reason}` }]);
  };

  const heldAt = (kind: Kind, path: string, stamp: FileStamp): Promise<FileRead<HashedDownloadedFile>> | undefined => {
    const known = kept[kind].get(path);
    return known !== undefined && sameStamp(known.stamp, stamp) ? known.hashed : undefined;
  };

  function hashAt(kind: Kind, path: string, stamp: FileStamp): Promise<FileRead<HashedDownloadedFile>> {
    const held = heldAt(kind, path, stamp);
    if (held !== undefined) return held;
    const readFromMs = Date.now();
    const entry: Kept = {
      stamp,
      hashed: readOrReason(() => (kind === 'downloadedFile' ? hashedWithEntries(path, stamp) : hashedAlone(path, stamp)))
        .then(async (read) => {
          shown(path, read);
          keepEntries(kind, read);
          await keep(kind, path, entry, read, readFromMs);
          return read;
        }),
    };
    kept[kind].set(path, entry);
    return entry.hashed;
  }

  // A file that is gone is no problem, and a file that cannot be stamped is one.
  async function stamped(path: string): Promise<FileRead<FileStamp>> {
    try {
      const stamp = await stampOf(path);
      return { kind: 'read', answer: stamp };
    } catch (err) {
      problems.set(path, errnoCode(err) === 'ENOENT' ? [] : [{ line: 1, message: `could not be hashed: ${errorMessage(err)}` }]);
      return { kind: 'unreadable', reason: errorMessage(err) };
    }
  }

  async function hashOf(kind: Kind, path: string): Promise<FileRead<HashedDownloadedFile>> {
    await load();
    const stamp = await stamped(path);
    return stamp.kind === 'unreadable' ? stamp : hashAt(kind, path, stamp.answer);
  }

  async function downloadedFilesHashed(
    paths: readonly string[], { onHashing, signal }: Parameters<HashIndex['downloadedFilesHashed']>[1] = {},
  ): Promise<DownloadedFilesHashed> {
    await load();
    const answers: { path: string; read: FileRead<HashedDownloadedFile> }[] = [];
    const unhashed: { path: string; stamp: FileStamp }[] = [];
    for (const path of paths) {
      const stamp = await stamped(path);
      const held = stamp.kind === 'unreadable' ? stamp : await heldAt('downloadedFile', path, stamp.answer);
      if (held !== undefined) answers.push({ path, read: held });
      else if (stamp.kind === 'read') unhashed.push({ path, stamp: stamp.answer });
    }
    for (const [done, { path, stamp }] of unhashed.entries()) {
      if (signal?.aborted) break;
      onHashing?.(unhashed.length - done);
      answers.push({ path, read: await hashAt('downloadedFile', path, stamp) });
    }
    return { files: answers.flatMap(({ path, read }) => (read.kind === 'read' ? [{ path, ...read.answer }] : [])), notes: unwrittenNote() };
  }

  function unwrittenNote(): string[] {
    const why = unwritten;
    unwritten = undefined;
    return why === undefined ? [] : [`the hash index could not be written, so the next run hashes these files again: ${why}`];
  }

  const hashAlone = async (kind: Kind, path: string): Promise<FileRead<Omit<HashedDownloadedFile, 'entries'>>> => {
    const read = await hashOf(kind, path);
    return read.kind === 'read' ? { kind: 'read', answer: { size: read.answer.size, hash: read.answer.hash } } : read;
  };

  return {
    originFileHash: (path) => hashAlone('origin', path),
    gameFileHash: (path) => hashAlone('game', path),
    downloadedFileHash: (path) => hashOf('downloadedFile', path),
    downloadedFilesHashed,
    keepPackageEntries: async (hash, entries) => {
      await load();
      const held = entriesByHash.get(hash);
      const alreadyKept = held?.size === entries.size && [...entries].every(([path, entryHash]) => held.get(path) === entryHash);
      entriesByHash.set(hash, entries);
      if (alreadyKept) return undefined;
      const stamp = { size: 0n, modifiedNs: 0n, changedNs: 0n };
      const line = lineOf('package', hash, stamp, { size: 0, hash, entries: [...entries].map(([path, entryHash]) => ({ path, hash: entryHash })) });
      return ensureDir(folder).then(() => append(indexFile, line)).then(() => undefined, (err: unknown) => errorMessage(err));
    },
    packageEntries: async (hash) => {
      await load();
      return entriesByHash.get(hash);
    },
  };
}
