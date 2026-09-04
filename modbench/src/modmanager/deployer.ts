// Hardlinks the winning copy of each file into Data/, and purges it back out. The manifest at
// mods/.medit-manifest.json makes purge exact and crash recovery self-contained. Native
// fs.link — no VFS.

import { copyFile, link, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { GameDirectory } from './gameDirectory';
import { foldPath, type FileConflictIndex } from './fileConflictIndex';

/** ADR-0026 surfacing: injected so business logic stays free of vscode types. */
export type Severity = 'error' | 'warning';
export interface Reporter {
  report(severity: Severity, message: string, detail?: string): void;
}

/** A load-order file (plugins.txt/loadorder.txt) copied to where the game reads it. */
export interface LoadOrderDeployment {
  source: string;
  target: string;
}

export interface DeployOptions {
  /** Load-order files to copy to the game-read location; recorded for purge. */
  loadOrder?: LoadOrderDeployment[];
  /** Link primitive; defaults to fs.link. Injectable for tests. */
  linkFn?: (source: string, target: string) => Promise<void>;
  /** Stat used for the same-volume check; injectable so the violation path is
   *  testable without a real second volume. Defaults to fs.stat. */
  statFn?: (p: string) => Promise<{ dev: number }>;
}

interface Manifest {
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

const MANIFEST_NAME = '.medit-manifest.json';

function manifestPath(instanceRoot: string): string {
  return join(instanceRoot, 'mods', MANIFEST_NAME);
}

/** The manifest's presence, which is what purge relies on, rather than a second notion of
 *  deployed-ness that could disagree. A corrupt manifest reads as deployed: there is state out
 *  there needing a purge. */
export async function isDeployed(instanceRoot: string): Promise<boolean> {
  try {
    await stat(manifestPath(instanceRoot));
    return true;
  } catch {
    return false;
  }
}

// A winner resolved through a symlink can live outside mods/, so `onSameVolume`'s coarse
// precheck does not guarantee every individual winner shares Data/'s volume: EXDEV becomes
// 'cross-volume'. Any other failure propagates.
async function linkWinner(
  target: string,
  winner: string,
  wasPreviouslyLinked: boolean,
  linkFn: (source: string, target: string) => Promise<void>,
): Promise<'linked' | 'skipped' | 'cross-volume'> {
  const existing = await statOrNull(target);
  if (existing) {
    // A vanilla/foreign file occupies this path — never overwrite it (ADR-0026
    // integrity tier: this mod's file silently failing to apply must not be silent).
    if (!wasPreviouslyLinked) return 'skipped';
    // Our own prior link. Leave it alone if it already points at this winner;
    // relink only when the winner changed (e.g. a reorder), avoiding needless churn.
    const src = await stat(winner);
    if (existing.ino === src.ino && existing.dev === src.dev) return 'linked';
    await rm(target, { force: true });
  } else {
    await mkdir(dirname(target), { recursive: true });
  }
  try {
    await linkFn(winner, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    return 'cross-volume';
  }
  return 'linked';
}

async function statOrNull(p: string): Promise<{ ino: number; dev: number } | null> {
  try {
    return await stat(p);
  } catch {
    return null; // absent
  }
}

/** Every file under `root`, as forward-slash relative paths. */
export async function listRelativeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(abs);
      else if (dirent.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  await walk(root);
  return out;
}

export async function deploy(
  instanceRoot: string,
  gameDirectory: GameDirectory,
  index: FileConflictIndex,
  reporter: Reporter,
  opts: DeployOptions = {},
): Promise<void> {
  const { dataFolder } = gameDirectory;

  const modsDir = join(instanceRoot, 'mods');
  const statFn = opts.statFn ?? ((p: string) => stat(p));
  if (!(await onSameVolume(modsDir, gameDirectory, statFn, reporter))) return;

  const baseline = await readBaseline(instanceRoot, dataFolder, reporter);
  if (!baseline) return;
  const { previousLinks, preExisting } = baseline;

  const { links, skipped, crossVolume } = await linkWinners(index, dataFolder, previousLinks, opts.linkFn ?? link);
  await removeStaleLinks(dataFolder, previousLinks, links);

  if (skipped.length > 0) {
    reporter.report(
      'warning',
      `${skipped.length} mod file(s) were not deployed — a file already exists in Data/.`,
      skipped.join('\n'),
    );
  }
  if (crossVolume.length > 0) {
    reporter.report(
      'warning',
      `${crossVolume.length} mod file(s) could not be deployed — their source is on a different drive than Data/ (e.g. a symlinked shared folder on another disk).`,
      crossVolume.join('\n'),
    );
  }

  const loadOrder = await deployLoadOrder(opts.loadOrder ?? [], reporter);

  const manifest: Manifest = { links, preExisting, loadOrder };
  await writeFile(manifestPath(instanceRoot), JSON.stringify(manifest, null, 2));
}

// Hardlinks need mods/ and the game directory on one volume. A mismatch is reported, never
// silently symlinked; the caller offers a stock-folder move instead.
async function onSameVolume(
  modsDir: string,
  gameDirectory: GameDirectory,
  statFn: (p: string) => Promise<{ dev: number }>,
  reporter: Reporter,
): Promise<boolean> {
  const [modsStat, gameStat] = await Promise.all([statFn(modsDir), statFn(gameDirectory.root)]);
  if (modsStat.dev === gameStat.dev) return true;
  reporter.report(
    'error',
    'Cannot deploy: mods/ and the game directory are on different drives. Point modbench.mods.gameDirectory at a stock folder on the same drive, or use the symlink fallback.',
    `mods/=${modsDir} game=${gameDirectory.root}`,
  );
  return false;
}

// Only a genuinely absent manifest snapshots Data/ as the vanilla baseline; a re-deploy must
// preserve the prior one, since Data/ already holds this deployer's links.
async function readBaseline(
  instanceRoot: string,
  dataFolder: string,
  reporter: Reporter,
): Promise<{ previousLinks: Map<string, string>; preExisting: string[] } | null> {
  const result = await readManifest(instanceRoot);
  switch (result.status) {
    case 'absent':
      return { previousLinks: new Map(), preExisting: await listRelativeFiles(dataFolder) };
    case 'corrupt':
      reportCorruptManifest(reporter, result.error);
      return null;
    case 'ok':
      return { previousLinks: toFoldedLinkMap(result.manifest.links), preExisting: result.manifest.preExisting };
  }
}

// Keyed by folded path but keeping the original casing, so a casing change is detectable
// against the prior casing rather than only the folded key.
function toFoldedLinkMap(links: string[]): Map<string, string> {
  return new Map(links.map((path) => [foldPath(path), path]));
}

// Found by folded key, but judged the same link only by exact casing: on ext4 an old-cased
// target is a distinct path and must be removed, or it is orphaned in Data/.
async function linkWinners(
  index: FileConflictIndex,
  dataFolder: string,
  previousLinks: Map<string, string>,
  linkFn: (source: string, target: string) => Promise<void>,
): Promise<{ links: string[]; skipped: string[]; crossVolume: string[] }> {
  const links: string[] = [];
  const skipped: string[] = [];
  const crossVolume: string[] = [];
  for (const entry of index.files) {
    const relativePath = entry.relativePath;
    // MO2 Root-Builder: a mod's root/ contents map to the game root, not Data/, so deploying
    // them into Data/root/ would be wrong. Folder only — a mod file literally named `root` is
    // not this convention and deploys normally.
    if (relativePath.startsWith('root/')) continue;

    const foldedKey = foldPath(relativePath);
    const priorPath = previousLinks.get(foldedKey);
    if (priorPath !== undefined && priorPath !== relativePath) {
      // The old-cased target is a distinct on-disk path from the new one; remove it explicitly.
      await rm(join(dataFolder, priorPath), { force: true });
    }
    const wasPreviouslyLinked = priorPath === relativePath;

    const outcome = await linkWinner(join(dataFolder, relativePath), entry.winner, wasPreviouslyLinked, linkFn);
    if (outcome === 'linked') links.push(relativePath);
    else if (outcome === 'cross-volume') crossVolume.push(relativePath);
    else skipped.push(relativePath);
  }
  return { links, skipped, crossVolume };
}

// A prior link whose folded key wins nothing now would otherwise be misfiled as a stray by the
// next purge. The "genuinely gone" case, distinct from a casing change.
async function removeStaleLinks(dataFolder: string, previousLinks: Map<string, string>, links: string[]): Promise<void> {
  const nowLinkedFolded = new Set(links.map(foldPath));
  for (const [foldedKey, path] of previousLinks) {
    if (!nowLinkedFolded.has(foldedKey)) await rm(join(dataFolder, path), { force: true });
  }
}

// A failure is reported but must not abort the deploy: the caller still has to write the
// manifest, or the links it created are orphaned.
async function deployLoadOrder(loadOrder: LoadOrderDeployment[], reporter: Reporter): Promise<string[]> {
  const written: string[] = [];
  for (const { source, target } of loadOrder) {
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      written.push(target);
    } catch (err) {
      reporter.report(
        'warning',
        'Deployed mod files, but could not write the load order — the game may not load the mods in order.',
        `${source} → ${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return written;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function readManifest(instanceRoot: string): Promise<ManifestResult> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(instanceRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'corrupt', error: toError(err) };
  }
  try {
    return { status: 'ok', manifest: JSON.parse(raw) as Manifest };
  } catch (err) {
    return { status: 'corrupt', error: toError(err) };
  }
}

function reportCorruptManifest(reporter: Reporter, error: Error): void {
  reporter.report(
    'error',
    'The deployment manifest is corrupt and could not be read — aborting to avoid corrupting the vanilla baseline.',
    error.message,
  );
}

// A corrupt manifest leaves the file on disk as evidence and the caller must abort without
// touching Data/; an absent one is a silent no-op.
async function resolveManifestForPurge(instanceRoot: string, reporter: Reporter): Promise<Manifest | null> {
  const result = await readManifest(instanceRoot);
  if (result.status === 'corrupt') reportCorruptManifest(reporter, result.error);
  return result.status === 'ok' ? result.manifest : null;
}

export interface PurgeOptions {
  /** Rename primitive; defaults to fs.rename. Injectable so the cross-volume (EXDEV)
   *  fallback is testable without a real second volume, same reason as DeployOptions'
   *  statFn. */
  renameFn?: (source: string, target: string) => Promise<void>;
}

export async function purge(
  instanceRoot: string,
  gameDirectory: GameDirectory,
  reporter: Reporter,
  opts: PurgeOptions = {},
): Promise<void> {
  const manifest = await resolveManifestForPurge(instanceRoot, reporter);
  if (!manifest) return;

  const { dataFolder } = gameDirectory;
  for (const relativePath of manifest.links) {
    await rm(join(dataFolder, relativePath), { force: true }); // tolerate ENOENT
  }
  for (const target of manifest.loadOrder ?? []) {
    await rm(target, { force: true });
  }

  const unmoved = await relocateStrayFiles(instanceRoot, dataFolder, manifest, opts.renameFn ?? rename);
  if (unmoved.length > 0) {
    reporter.report(
      'warning',
      `${unmoved.length} file(s) could not be moved out of Data/ into overwrite/.`,
      unmoved.join('\n'),
    );
  }

  await pruneEmptyDirs(dataFolder);
  await rm(manifestPath(instanceRoot), { force: true });
}

// Anything in Data/ that is neither a link nor part of the vanilla baseline is a runtime output
// worth preserving in overwrite/. Folded-path comparison, because Proton/Wine resolves casing
// insensitively.
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
    const to = join(instanceRoot, 'overwrite', relativePath);
    try {
      await mkdir(dirname(to), { recursive: true });
      await moveFile(from, to, renameFn);
    } catch (err) {
      // ADR-0026 integrity: a file left in Data/ must not be silent.
      unmoved.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
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
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

// `root` itself is kept.
async function pruneEmptyDirs(root: string): Promise<void> {
  for (const dirent of await readdir(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(root, dirent.name);
    await pruneEmptyDirs(dir);
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  }
}
