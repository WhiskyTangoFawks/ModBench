// MO2 files: the one reader and writer of the instance (target-architecture.d2's `mo2files`
// box). A command splices a file's text through its own codec and puts the result through here.

import { existsSync, type Dirent } from 'node:fs';
import {
  access, copyFile, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rename as fsRename, rm, rmdir, stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { modsDir as modsDirOf, modGitDir, overwriteDir, profilesDir, settingsFile } from './layout';
import type { GameDirectory } from './gameDirectory';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';

/** Structural presence only, never file contents: an instance with a corrupt `modlist.txt` still
 *  reads `true` here, and surfaces that error elsewhere (ADR-0019). Synchronous: the composition
 *  root asks before an Instance exists. */
export function isMo2Instance(root: string): boolean {
  return existsSync(settingsFile(root)) && existsSync(modsDirOf(root)) && existsSync(profilesDir(root));
}

/** ADR-0007: tracked *is* the presence of `.git` in the mod's folder — no registry, no backend. */
export function isTracked(modFolder: string): Promise<boolean> {
  return exists(modGitDir(modFolder));
}

// One chain per path in flight: a file with no writer pending costs nothing, and two different
// paths never serialize against each other. Module-level, so every command shares one adapter.
const chains = new Map<string, Promise<unknown>>();

// Runs `task` after every task already queued on `key`, and answers what it answered.
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const next = prior.then(task, task);
  // The chain tail must never stay rejected, or a later write on this key queues behind a dead
  // link forever — only the caller's own `next` sees the error.
  const settled = next.then(() => undefined, () => undefined);
  chains.set(key, settled);
  // An idle key is forgotten, so a long session holds only what is in flight.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}

async function readOr(path: string, ifMissing: string | undefined): Promise<string> {
  if (ifMissing === undefined) return readFile(path, 'utf8');
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return ifMissing;
  }
}

export interface PutOptions {
  /** A missing file reads as this text rather than rejecting. Omit to have a missing file
   *  refuse the write. */
  ifMissing?: string;
}

/** Whether `path`, file or directory, is there. Only a missing path answers false; any other
 *  failure (a permission error, say) propagates rather than reading as absent (ADR-0019). */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export interface PathFacts {
  readonly size: number;
  readonly mtimeMs: number;
  /** `other` covers a non-regular target (a socket, FIFO or device node) — a caller's own
   *  skip-and-log, never a fourth branch here. */
  readonly kind: 'file' | 'directory' | 'other';
  /** `path` with every symlink along it resolved; itself when `path` names no symlink. */
  readonly realPath: string;
}

/** `path`'s size, modified time and kind, following symlinks the way a directory walk does —
 *  `stat`, not `lstat`. Sequential, so a `stat` failure propagates before `realpath` runs. */
export async function factsOf(path: string): Promise<PathFacts> {
  const info = await stat(path);
  const kind: PathFacts['kind'] = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
  const realPath = await realpath(path);
  return { size: info.size, mtimeMs: info.mtimeMs, kind, realPath };
}

/** Reads `path` as text. Pass `ifMissing` to read a missing file as that text instead of
 *  rejecting. */
export function get(path: string, ifMissing?: string): Promise<string> {
  return readOr(path, ifMissing);
}

/** Writes `text` to `path` outright — no read-back, no splice, no lock: a landing mod's own
 *  meta.ini, written once into a staged tree nothing else can see yet. */
export function write(path: string, text: string): Promise<void> {
  return writeFile(path, text);
}

/** Moves `from` to `to` in one filesystem step — a staged tree landing in `mods/`, or an
 *  install's own entries moving into an existing mod folder. */
export function rename(from: string, to: string): Promise<void> {
  return fsRename(from, to);
}

/** Copies `from`'s whole tree to `to`, leaving `from` in place — a source folder staged before
 *  its one rename into `mods/`. */
export function copyTree(from: string, to: string): Promise<void> {
  return cp(from, to, { recursive: true });
}

/** A fresh, uniquely-named directory next to `prefix`, for a staged tree no watcher's glob
 *  reaches until its one rename into place. */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(prefix);
}

/** `path`'s directory entries; the caller's own filter picks the ones it wants. */
export function listDir(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
}

/** Creates `path` and every missing parent; a no-op when it is already there. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Deletes `path`, file or directory, and everything under it; already-gone is not an error. */
export function remove(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

/** Reads `path`, hands the text to `edit`, and always writes the result back once — the download
 *  sidecar's own contract (ADR-0014 invariant 4). Serialized per path. */
export async function put(path: string, edit: (before: string) => string, opts: PutOptions = {}): Promise<void> {
  await withLock(path, async () => {
    const before = await readOr(path, opts.ifMissing);
    await writeFile(path, edit(before));
  });
}

/** Like {@link put}, but skips the write when `edit` changed nothing, so an unwritten file never
 *  fires its watcher. Answers whether it wrote. */
export function putIfChanged(
  path: string, edit: (before: string) => string, opts: PutOptions = {},
): Promise<{ wrote: boolean }> {
  return withLock(path, async () => {
    const before = await readOr(path, opts.ifMissing);
    const after = edit(before);
    if (after === before) return { wrote: false };
    await writeFile(path, after);
    return { wrote: true };
  });
}

// --- Deploy and purge: hardlink and manifest into Game Data/ (target-architecture.d2's
// `mo2files` box). Deploy commands hands the pairs to hardlink; this is where they land.

const MANIFEST_FILE_NAME = '.medit-manifest.json';

/** Deploy's own manifest path — Modbench's file, not MO2's, so not in `mo2/layout.ts`.
 *  Exported so the Instance can check its presence through {@link exists}. */
export function manifestFile(instanceRoot: string): string {
  return join(modsDirOf(instanceRoot), MANIFEST_FILE_NAME);
}

/** One file to hardlink into Game Data/, as deploy commands read it off the value's winners. */
export interface DeployLink {
  /** Data/-relative path to hardlink. */
  relativePath: string;
  /** Absolute path of the winner to hardlink. */
  source: string;
}

/** A load-order file (plugins.txt/loadorder.txt) copied to where the game reads it. */
export interface LoadOrderDeployment {
  source: string;
  target: string;
}

/** A non-fatal condition worth telling the user about. Toolbox reports this; this module
 *  reports to nobody. */
export interface DeployWarning {
  message: string;
  detail?: string;
}

export interface DeployOptions {
  /** Link primitive; defaults to fs.link. Injectable for tests. */
  linkFn?: (source: string, target: string) => Promise<void>;
  /** Stat used for the same-volume check; injectable so the violation path is
   *  testable without a real second volume. Defaults to fs.stat. */
  statFn?: (p: string) => Promise<{ dev: number }>;
}

export interface PurgeOptions {
  /** Rename primitive; defaults to fs.rename. Injectable so the EXDEV fallback is
   *  testable without a real second volume. */
  renameFn?: (source: string, target: string) => Promise<void>;
}

/** `refusal` set means a precondition aborted the run before touching Data/. `warnings` covers
 *  everything that still let the deploy write. */
export type DeployOutcome =
  | { wrote: true; warnings: DeployWarning[] }
  | { wrote: false; refusal: string };

/** `refusal` unset means there was nothing to purge — a no-op, not a failure. */
export type PurgeOutcome =
  | { wrote: true; warnings: DeployWarning[] }
  | { wrote: false; refusal?: string };

export interface Manifest {
  /** Data/-relative paths we hardlinked. */
  links: string[];
  /** Data/ files present before the first deploy — the vanilla baseline. */
  preExisting: string[];
  /** Absolute paths of load-order files we deployed. */
  loadOrder?: string[];
}

// 'absent' and 'corrupt' must stay distinct: conflating them re-snapshots a Data/ that already
// holds this deployer's own links as the vanilla baseline.
type ManifestResult =
  | { status: 'absent' }
  | { status: 'corrupt'; error: Error }
  | { status: 'ok'; manifest: Manifest };

// fileConflictIndex.ts already imports factsOf/listDir from here; importing its foldPath back
// would cycle, so this one line is duplicated instead.
function foldPath(relativePath: string): string {
  return relativePath.toLowerCase();
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string');
}

// The manifest's one parse point: checks the fields a manifest always has and throws rather
// than handing back an unproven shape. readManifest, below, catches it; exported for reuse
// by a test reading its own deployed manifest.
export function parseManifest(raw: string): Manifest {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected the deploy manifest to be a JSON object, got ${typeof parsed}.`);
  }
  const witness = parsed as { links?: unknown; preExisting?: unknown; loadOrder?: unknown };
  if (!isStringArray(witness.links)) {
    throw new Error('Expected the deploy manifest to have a "links" string array.');
  }
  if (!isStringArray(witness.preExisting)) {
    throw new Error('Expected the deploy manifest to have a "preExisting" string array.');
  }
  if (witness.loadOrder !== undefined && !isStringArray(witness.loadOrder)) {
    throw new Error('Expected the deploy manifest\'s "loadOrder" to be a string array when present.');
  }
  return { links: witness.links, preExisting: witness.preExisting, loadOrder: witness.loadOrder };
}

async function readManifest(instanceRoot: string): Promise<ManifestResult> {
  let raw: string;
  try {
    raw = await readFile(manifestFile(instanceRoot), 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { status: 'absent' };
    return { status: 'corrupt', error: toError(err) };
  }
  try {
    return { status: 'ok', manifest: parseManifest(raw) };
  } catch (err) {
    return { status: 'corrupt', error: toError(err) };
  }
}

const CORRUPT_MANIFEST_MESSAGE =
  'The deployment manifest is corrupt and could not be read — aborting to avoid corrupting the vanilla baseline.';

function corruptManifestRefusal(error: Error): string {
  return `${CORRUPT_MANIFEST_MESSAGE} ${error.message}`;
}

/** Every file under `root`, as forward-slash relative paths. */
export async function listRelativeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const dirent of await listDir(dir)) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(abs);
      else if (dirent.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  await walk(root);
  return out;
}

async function statOrNull(p: string): Promise<{ ino: number; dev: number } | null> {
  try {
    return await stat(p);
  } catch {
    return null; // absent
  }
}

// EXDEV becomes 'cross-volume' rather than propagating: a symlinked winner can live outside
// mods/, off the same volume as Data/, even when mods/ itself is not.
async function linkOneWinner(
  target: string,
  winner: string,
  wasPreviouslyLinked: boolean,
  linkFn: (source: string, target: string) => Promise<void>,
): Promise<'linked' | 'skipped' | 'cross-volume'> {
  const existing = await statOrNull(target);
  if (existing) {
    // A vanilla/foreign file occupies this path — never overwrite it (ADR-0019).
    if (!wasPreviouslyLinked) return 'skipped';
    // Our own prior link: leave it if it already points at this winner, relink only on change.
    const src = await stat(winner);
    if (existing.ino === src.ino && existing.dev === src.dev) return 'linked';
    await rm(target, { force: true });
  } else {
    await mkdir(dirname(target), { recursive: true });
  }
  try {
    await linkFn(winner, target);
  } catch (err) {
    if (errnoCode(err) !== 'EXDEV') throw err;
    return 'cross-volume';
  }
  return 'linked';
}

// Keeps the original casing per folded key, so a casing change is detectable against the
// prior casing rather than only the folded key.
function toFoldedLinkMap(links: string[]): Map<string, string> {
  return new Map(links.map((path) => [foldPath(path), path]));
}

// Only a genuinely absent manifest snapshots Data/ as the vanilla baseline; a re-deploy must
// preserve the prior one, since Data/ already holds this deployer's links.
async function readBaseline(
  instanceRoot: string,
  dataFolder: string,
): Promise<
  | { status: 'ok'; previousLinks: Map<string, string>; preExisting: string[] }
  | { status: 'corrupt'; error: Error }
> {
  const result = await readManifest(instanceRoot);
  switch (result.status) {
    case 'absent':
      return { status: 'ok', previousLinks: new Map(), preExisting: await listRelativeFiles(dataFolder) };
    case 'corrupt':
      return { status: 'corrupt', error: result.error };
    case 'ok':
      return { status: 'ok', previousLinks: toFoldedLinkMap(result.manifest.links), preExisting: result.manifest.preExisting };
  }
}

// Found by folded key, but judged the same link only by exact casing: on ext4 an old-cased
// target is a distinct path and must be removed, or it is orphaned in Data/.
async function linkWinners(
  links: DeployLink[],
  dataFolder: string,
  previousLinks: Map<string, string>,
  linkFn: (source: string, target: string) => Promise<void>,
): Promise<{ links: string[]; skipped: string[]; crossVolume: string[] }> {
  const linked: string[] = [];
  const skipped: string[] = [];
  const crossVolume: string[] = [];
  for (const { relativePath, source } of links) {
    const foldedKey = foldPath(relativePath);
    const priorPath = previousLinks.get(foldedKey);
    if (priorPath !== undefined && priorPath !== relativePath) {
      await rm(join(dataFolder, priorPath), { force: true });
    }
    const wasPreviouslyLinked = priorPath === relativePath;

    const outcome = await linkOneWinner(join(dataFolder, relativePath), source, wasPreviouslyLinked, linkFn);
    if (outcome === 'linked') linked.push(relativePath);
    else if (outcome === 'cross-volume') crossVolume.push(relativePath);
    else skipped.push(relativePath);
  }
  return { links: linked, skipped, crossVolume };
}

// A prior link whose folded key wins nothing now would otherwise be misfiled as a stray by the
// next purge — the "genuinely gone" case, distinct from a casing change.
async function removeStaleLinks(dataFolder: string, previousLinks: Map<string, string>, links: string[]): Promise<void> {
  const nowLinkedFolded = new Set(links.map(foldPath));
  for (const [foldedKey, path] of previousLinks) {
    if (!nowLinkedFolded.has(foldedKey)) await rm(join(dataFolder, path), { force: true });
  }
}

// A failure is collected, not thrown: the caller still has to write the manifest, or the
// links it already made are orphaned.
async function deployLoadOrder(
  loadOrder: LoadOrderDeployment[],
): Promise<{ written: string[]; failed: { source: string; target: string; error: string }[] }> {
  const written: string[] = [];
  const failed: { source: string; target: string; error: string }[] = [];
  for (const { source, target } of loadOrder) {
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      written.push(target);
    } catch (err) {
      failed.push({ source, target, error: errorMessage(err) });
    }
  }
  return { written, failed };
}

// Hardlinks need mods/ and the game directory on one volume; a mismatch aborts rather than
// silently symlinking.
async function sameVolumeViolation(
  modsDir: string,
  gameDirectory: GameDirectory,
  statFn: (p: string) => Promise<{ dev: number }>,
): Promise<string | undefined> {
  const [modsStat, gameStat] = await Promise.all([statFn(modsDir), statFn(gameDirectory.root)]);
  if (modsStat.dev === gameStat.dev) return undefined;
  return 'Cannot deploy: mods/ and the game directory are on different drives. Point ' +
    'modbench.mods.gameDirectory at a stock folder on the same drive, or use the symlink ' +
    `fallback. (modsDir=${modsDir} game=${gameDirectory.root})`;
}

/** Hardlinks each of `links` into `gameDirectory.dataFolder`, copies `loadOrder` to where the
 *  game reads it, and writes the manifest that makes purge exact. Serializes with purge on
 *  the same instance. */
export function deployToGameData(
  instanceRoot: string,
  gameDirectory: GameDirectory,
  links: DeployLink[],
  loadOrder: LoadOrderDeployment[] = [],
  opts: DeployOptions = {},
): Promise<DeployOutcome> {
  return withLock(`deploy:${instanceRoot}`, async (): Promise<DeployOutcome> => {
    const { dataFolder } = gameDirectory;
    const modsDir = modsDirOf(instanceRoot);
    const statFn = opts.statFn ?? ((p: string) => stat(p));

    const volumeViolation = await sameVolumeViolation(modsDir, gameDirectory, statFn);
    if (volumeViolation) return { wrote: false, refusal: volumeViolation };

    const baseline = await readBaseline(instanceRoot, dataFolder);
    if (baseline.status === 'corrupt') return { wrote: false, refusal: corruptManifestRefusal(baseline.error) };
    const { previousLinks, preExisting } = baseline;

    const { links: linked, skipped, crossVolume } =
      await linkWinners(links, dataFolder, previousLinks, opts.linkFn ?? link);
    await removeStaleLinks(dataFolder, previousLinks, linked);

    const warnings: DeployWarning[] = [];
    if (skipped.length > 0) {
      warnings.push({
        message: `${skipped.length} mod file(s) were not deployed — a file already exists in Data/.`,
        detail: skipped.join('\n'),
      });
    }
    if (crossVolume.length > 0) {
      warnings.push({
        message: `${crossVolume.length} mod file(s) could not be deployed — their source is on a ` +
          'different drive than Data/ (e.g. a symlinked shared folder on another disk).',
        detail: crossVolume.join('\n'),
      });
    }

    const { written: loadOrderWritten, failed: loadOrderFailed } = await deployLoadOrder(loadOrder);
    for (const failure of loadOrderFailed) {
      warnings.push({
        message: 'Deployed mod files, but could not write the load order — the game may not load the mods in order.',
        detail: `${failure.source} → ${failure.target}: ${failure.error}`,
      });
    }

    const manifest: Manifest = { links: linked, preExisting, loadOrder: loadOrderWritten };
    await writeFile(manifestFile(instanceRoot), JSON.stringify(manifest, null, 2));
    return { wrote: true, warnings };
  });
}

// Anything in Data/ neither a link nor part of the vanilla baseline is a runtime output worth
// preserving in overwrite/. Folded-path comparison: Proton/Wine resolves casing insensitively.
async function relocateStrayFiles(
  instanceRoot: string,
  dataFolder: string,
  manifest: Manifest,
  renameFn: (source: string, target: string) => Promise<void>,
): Promise<string[]> {
  const keptFolded = new Set([...manifest.links, ...manifest.preExisting].map(foldPath));
  const unmoved: string[] = [];
  for (const relativePath of await listRelativeFiles(dataFolder)) {
    if (keptFolded.has(foldPath(relativePath))) continue;
    const from = join(dataFolder, relativePath);
    const to = join(overwriteDir(instanceRoot), relativePath);
    try {
      await mkdir(dirname(to), { recursive: true });
      await moveFile(from, to, renameFn);
    } catch (err) {
      unmoved.push(`${relativePath}: ${errorMessage(err)}`); // ADR-0019 invariant 2: integrity, never silent
    }
  }
  return unmoved;
}

// Falls back to copy+delete across volumes (rename's EXDEV).
async function moveFile(
  from: string,
  to: string,
  renameFn: (source: string, target: string) => Promise<void>,
): Promise<void> {
  try {
    await renameFn(from, to);
  } catch (err) {
    if (errnoCode(err) !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

// `root` itself is kept.
async function pruneEmptyDirs(root: string): Promise<void> {
  for (const dirent of await listDir(root)) {
    if (!dirent.isDirectory()) continue;
    const dir = join(root, dirent.name);
    await pruneEmptyDirs(dir);
    if ((await listDir(dir)).length === 0) await rmdir(dir);
  }
}

/** Deletes every hardlink and load-order copy the manifest names, relocates strays into
 *  overwrite/, prunes directories that leaves empty, then deletes the manifest. Serializes
 *  with deploy on the same instance. */
export function purgeFromGameData(
  instanceRoot: string,
  gameDirectory: GameDirectory,
  opts: PurgeOptions = {},
): Promise<PurgeOutcome> {
  return withLock(`deploy:${instanceRoot}`, async (): Promise<PurgeOutcome> => {
    const result = await readManifest(instanceRoot);
    if (result.status === 'absent') return { wrote: false };
    if (result.status === 'corrupt') return { wrote: false, refusal: corruptManifestRefusal(result.error) };
    const { manifest } = result;

    const { dataFolder } = gameDirectory;
    for (const relativePath of manifest.links) {
      await rm(join(dataFolder, relativePath), { force: true }); // tolerate ENOENT
    }
    for (const target of manifest.loadOrder ?? []) {
      await rm(target, { force: true });
    }

    const warnings: DeployWarning[] = [];
    const unmoved = await relocateStrayFiles(instanceRoot, dataFolder, manifest, opts.renameFn ?? fsRename);
    if (unmoved.length > 0) {
      warnings.push({
        message: `${unmoved.length} file(s) could not be moved out of Data/ into overwrite/.`,
        detail: unmoved.join('\n'),
      });
    }

    await pruneEmptyDirs(dataFolder);
    await rm(manifestFile(instanceRoot), { force: true });
    return { wrote: true, warnings };
  });
}
