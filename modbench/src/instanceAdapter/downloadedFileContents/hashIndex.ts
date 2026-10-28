// The hashes the adapter keeps (ADR-0013): downloaded and game files' in its index, origin files' for the session,
// each trusted while its file's stamp is the one it was hashed at.

import { join } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
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
type IndexedKind = Exclude<Kind, 'origin'>;

interface Kept {
  readonly stamp: FileStamp;
  readonly hashed: Promise<FileRead<HashedDownloadedFile>>;
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;

const settledBefore = (stamp: FileStamp, readFromMs: number): boolean =>
  stamp.changedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n;

const lineOf = (kind: IndexedKind, path: string, stamp: FileStamp, { hash, entries }: HashedDownloadedFile): string =>
  `${JSON.stringify([
    kind, path, String(stamp.size), String(stamp.modifiedNs), String(stamp.changedNs), hash,
    ...entries.flatMap((entry) => [entry.path, entry.hash]),
  ])}\n`;

type Line = [IndexedKind, string, string, string, string, string, ...string[]];

const isLine = (fields: unknown): fields is Line =>
  Array.isArray(fields) && fields.length >= 6 && fields.length % 2 === 0
  && fields.every((field) => typeof field === 'string') && (fields[0] === 'game' || fields[0] === 'downloadedFile');

function keptAt(line: string): { kind: IndexedKind; path: string; stamp: FileStamp; hashed: HashedDownloadedFile } | undefined {
  try {
    const fields: unknown = JSON.parse(line);
    if (!isLine(fields)) return undefined;
    const [kind, path, size, modifiedNs, changedNs, hash, ...entries] = fields;
    const stamp = { size: BigInt(size), modifiedNs: BigInt(modifiedNs), changedNs: BigInt(changedNs) };
    const pairs = entries.flatMap((entryPath, i) => (i % 2 === 0 ? [{ path: entryPath, hash: entries[i + 1] ?? '' }] : []));
    return { kind, path, stamp, hashed: { size: Number(stamp.size), hash, entries: pairs } };
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

interface IndexedDownloadedFiles {
  readonly files: readonly (HashedDownloadedFile & { readonly path: string })[];
  readonly notes: readonly string[];
}

// A file gone from disk, or changed since it was hashed, is not held; one that cannot be read is named.
async function heldAtTheirStamps(held: ReadonlyMap<string, Kept>): Promise<IndexedDownloadedFiles> {
  const listed = await Promise.all([...held].map(async ([path, known]): Promise<IndexedDownloadedFiles> => {
    const stamped = await stampOf(path).then((stamp) => ({ stamp }), (err: unknown) => ({ err }));
    if ('err' in stamped) return { files: [], notes: errnoCode(stamped.err) === 'ENOENT' ? [] : [`${path} could not be read: ${errorMessage(stamped.err)}`] };
    if (!sameStamp(known.stamp, stamped.stamp)) return { files: [], notes: [] };
    const read = await known.hashed;
    if (read.kind === 'unreadable') return { files: [], notes: [`${path} could not be read: ${read.reason}`] };
    return { files: held.get(path) === known ? [{ path, ...read.answer }] : [], notes: [] };
  }));
  return { files: listed.flatMap(({ files }) => files), notes: listed.flatMap(({ notes }) => notes) };
}

/** The adapter's hashes, its index in `folder`, which it alone writes; a downloaded file's entries are hashed from
 *  its extraction there. */
export interface HashIndex extends Pick<InstanceAdapter, 'originFileHash'> {
  /** A game file's size and hash, the hash as mEdit's manifest carries it, kept in the record index (ADR-0013). */
  gameFileHash(path: string): Promise<FileRead<HashedFile>>;
  /** The size and hash of the downloaded file at `path`, and of each of its entries, kept in the hash index. */
  downloadedFileHash(path: string): Promise<FileRead<HashedDownloadedFile>>;
  /** The downloaded files the index holds at the stamp each was hashed at, with their entries, and why the index or a file
   *  could not be read. It hashes and extracts nothing. */
  indexedDownloadedFiles(): Promise<IndexedDownloadedFiles>;
}

export function hashIndex(folder: string, installationFileReader: InstallationFileReader): HashIndex {
  const indexFile = join(folder, INDEX_FILE);
  const kept: Record<Kind, Map<string, Kept>> = { origin: new Map(), game: new Map(), downloadedFile: new Map() };
  let loaded: Promise<void> | undefined;
  let unreadIndex: string | undefined;

  // The record index only spares a read: one that cannot be read or written costs a read again, never a wrong hash.
  const load = (): Promise<void> => (loaded ??= removeLeftoverExtractions(folder).then(() => get(indexFile, '')).then((text) => {
    for (const line of text.split('\n')) {
      const known = keptAt(line);
      if (known !== undefined) kept[known.kind].set(known.path, { stamp: known.stamp, hashed: Promise.resolve({ kind: 'read', answer: known.hashed }) });
    }
  }, (err: unknown) => { unreadIndex = errorMessage(err); }));

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

  async function keep(kind: Kind, path: string, entry: Kept, read: FileRead<HashedDownloadedFile>, readFromMs: number): Promise<void> {
    if (kept[kind].get(path) !== entry) return;
    if (read.kind === 'unreadable' || !settledBefore(entry.stamp, readFromMs)) {
      kept[kind].delete(path);
      return;
    }
    if (kind === 'origin') return;
    await ensureDir(folder).then(() => append(indexFile, lineOf(kind, path, entry.stamp, read.answer))).catch(() => undefined);
  }

  async function hashOf(kind: Kind, path: string): Promise<FileRead<HashedDownloadedFile>> {
    await load();
    const stamped = await readOrReason(() => stampOf(path));
    if (stamped.kind === 'unreadable') return stamped;
    const stamp = stamped.answer;
    const known = kept[kind].get(path);
    if (known !== undefined && sameStamp(known.stamp, stamp)) return known.hashed;
    const readFromMs = Date.now();
    const entry: Kept = {
      stamp,
      hashed: readOrReason(() => (kind === 'downloadedFile' ? hashedWithEntries(path, stamp) : hashedAlone(path, stamp)))
        .then(async (read) => {
          await keep(kind, path, entry, read, readFromMs);
          return read;
        }),
    };
    kept[kind].set(path, entry);
    return entry.hashed;
  }

  const hashAlone = async (kind: Kind, path: string): Promise<FileRead<Omit<HashedDownloadedFile, 'entries'>>> => {
    const read = await hashOf(kind, path);
    return read.kind === 'read' ? { kind: 'read', answer: { size: read.answer.size, hash: read.answer.hash } } : read;
  };

  return {
    originFileHash: (path) => hashAlone('origin', path),
    gameFileHash: (path) => hashAlone('game', path),
    downloadedFileHash: (path) => hashOf('downloadedFile', path),
    indexedDownloadedFiles: async () => {
      await load();
      const { files, notes } = await heldAtTheirStamps(kept.downloadedFile);
      return { files, notes: unreadIndex === undefined ? notes : [`the downloaded files hashed before could not be read: ${unreadIndex}`, ...notes] };
    },
  };
}
