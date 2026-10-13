// The hashes the adapter keeps (ADR-0013): downloaded and game files' in its index, origin files' for the session,
// each trusted while its file's stamp is the one it was hashed at.

import { join } from 'node:path';
import type { ArchiveReader } from './archiveReader';
import { digestOf } from './contentDigest';
import { append, ensureDir, get, listDir, makeTempDir, readOrReason, remove, stampOf, withLock } from './files';
import type { FileRead, FileStamp, HashedDownload, InstanceAdapter } from './instanceAdapter';

const INDEX_FILE = 'hashes.jsonl';
const EXTRACTION_PREFIX = 'entries-';

// A file system stamps a change with a clock coarser than a hash is quick, and a network share's
// clock is not this machine's: a stamp this recent may not change for a write that follows it.
const SETTLED_AFTER_MS = 2_000;

type Kind = 'origin' | 'game' | 'download';
type IndexedKind = Exclude<Kind, 'origin'>;

interface Kept {
  readonly stamp: FileStamp;
  readonly hashed: Promise<FileRead<HashedDownload>>;
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;

const settledBefore = (stamp: FileStamp, readFromMs: number): boolean =>
  stamp.changedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n;

const lineOf = (kind: IndexedKind, path: string, stamp: FileStamp, { hash, entries }: HashedDownload): string =>
  `${JSON.stringify([
    kind, path, String(stamp.size), String(stamp.modifiedNs), String(stamp.changedNs), hash,
    ...entries.flatMap((entry) => [entry.path, entry.hash]),
  ])}\n`;

type Line = [IndexedKind, string, string, string, string, string, ...string[]];

const isLine = (fields: unknown): fields is Line =>
  Array.isArray(fields) && fields.length >= 6 && fields.length % 2 === 0
  && fields.every((field) => typeof field === 'string') && (fields[0] === 'game' || fields[0] === 'download');

function keptAt(line: string): { kind: IndexedKind; path: string; stamp: FileStamp; hashed: HashedDownload } | undefined {
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

// An extraction is a whole archive, so one a crash left behind would hold its space for good.
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

/** The adapter's hashes, its index in `folder`, which it alone writes; a downloaded file's entries are hashed from
 *  its extraction there. */
export function hashIndex(folder: string, archives: ArchiveReader): Pick<InstanceAdapter, 'originFileHash' | 'gameFileHash' | 'downloadedFileHash'> {
  const indexFile = join(folder, INDEX_FILE);
  const kept: Record<Kind, Map<string, Kept>> = { origin: new Map(), game: new Map(), download: new Map() };
  let loaded: Promise<void> | undefined;

  // The index only spares a read: one that cannot be read or written costs a read again, never a wrong hash.
  const load = (): Promise<void> => (loaded ??= removeLeftoverExtractions(folder).then(() => get(indexFile, '')).then((text) => {
    for (const line of text.split('\n')) {
      const known = keptAt(line);
      if (known !== undefined) kept[known.kind].set(known.path, { stamp: known.stamp, hashed: Promise.resolve({ kind: 'read', answer: known.hashed }) });
    }
  }, () => undefined));

  const hashedAlone = async (path: string, stamp: FileStamp): Promise<HashedDownload> =>
    ({ size: Number(stamp.size), hash: await digestOf(path), entries: [] });

  // One extraction at a time: each is a whole archive on disk.
  const hashedWithEntries = (path: string, stamp: FileStamp): Promise<HashedDownload> => withLock(join(folder, EXTRACTION_PREFIX), async () => {
    const listed = await archives.list(path);
    refuseCaseCollisions(listed);
    await ensureDir(folder);
    const extraction = await makeTempDir(join(folder, EXTRACTION_PREFIX));
    try {
      await archives.extract(path, extraction);
      const entries = [];
      for (const entry of listed) entries.push({ path: entry, hash: await digestOf(join(extraction, entry)) });
      return { ...(await hashedAlone(path, stamp)), entries };
    } finally {
      await remove(extraction);
    }
  });

  async function keep(kind: Kind, path: string, entry: Kept, read: FileRead<HashedDownload>, readFromMs: number): Promise<void> {
    if (kept[kind].get(path) !== entry) return;
    if (read.kind === 'unreadable' || !settledBefore(entry.stamp, readFromMs)) {
      kept[kind].delete(path);
      return;
    }
    if (kind === 'origin') return;
    await ensureDir(folder).then(() => append(indexFile, lineOf(kind, path, entry.stamp, read.answer))).catch(() => undefined);
  }

  async function hashOf(kind: Kind, path: string): Promise<FileRead<HashedDownload>> {
    await load();
    const stamped = await readOrReason(() => stampOf(path));
    if (stamped.kind === 'unreadable') return stamped;
    const stamp = stamped.answer;
    const known = kept[kind].get(path);
    if (known !== undefined && sameStamp(known.stamp, stamp)) return known.hashed;
    const readFromMs = Date.now();
    const entry: Kept = {
      stamp,
      hashed: readOrReason(() => (kind === 'download' ? hashedWithEntries(path, stamp) : hashedAlone(path, stamp)))
        .then(async (read) => {
          await keep(kind, path, entry, read, readFromMs);
          return read;
        }),
    };
    kept[kind].set(path, entry);
    return entry.hashed;
  }

  const hashAlone = async (kind: Kind, path: string): Promise<FileRead<Omit<HashedDownload, 'entries'>>> => {
    const read = await hashOf(kind, path);
    return read.kind === 'read' ? { kind: 'read', answer: { size: read.answer.size, hash: read.answer.hash } } : read;
  };

  return {
    originFileHash: (path) => hashAlone('origin', path),
    gameFileHash: (path) => hashAlone('game', path),
    downloadedFileHash: (path) => hashOf('download', path),
  };
}
