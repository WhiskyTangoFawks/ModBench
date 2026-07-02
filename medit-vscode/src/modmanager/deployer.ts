// Standalone deployer: hardlinks the merged mod view (the FileConflictIndex
// winner map) into the game directory's Data/, and purges it back out. The
// binary plugins remain the source of truth; a manifest at
// mods/.medit-manifest.json records what we created so purge is exact and
// crash-recovery is self-contained. Native fs.link — no VFS, no P/Invoke.

import { copyFile, link, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { GameDirectory } from './gameDirectory';
import type { FileConflictIndex } from './fileConflictIndex';

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

const MANIFEST_NAME = '.medit-manifest.json';

function manifestPath(instanceRoot: string): string {
  return join(instanceRoot, 'mods', MANIFEST_NAME);
}

/** Link one winner into Data/. Skips (returns 'skipped') when a vanilla/foreign
 *  file already occupies the target; leaves an unchanged prior link untouched;
 *  relinks only when the winner's inode changed. */
async function linkWinner(
  target: string,
  winner: string,
  wasPreviouslyLinked: boolean,
  linkFn: (source: string, target: string) => Promise<void>,
): Promise<'linked' | 'skipped'> {
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
  await linkFn(winner, target);
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
async function listRelativeFiles(root: string): Promise<string[]> {
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

  // Hardlinks require mods/ and the game directory to share a volume. Bail before
  // touching anything if they don't (ADR-0026 "explicit action failed") — the
  // caller offers a stock-folder move or symlink fallback; we never silently symlink.
  const statFn = opts.statFn ?? ((p: string) => stat(p));
  const modsDir = join(instanceRoot, 'mods');
  const [modsStat, gameStat] = await Promise.all([statFn(modsDir), statFn(gameDirectory.root)]);
  if (modsStat.dev !== gameStat.dev) {
    reporter.report(
      'error',
      'Cannot deploy: mods/ and the game directory are on different drives. Point mEdit.mods.gameDirectory at a stock folder on the same drive, or use the symlink fallback.',
      `mods/=${modsDir} game=${gameDirectory.root}`,
    );
    return;
  }

  const previous = await readManifest(instanceRoot);
  const previousLinks = new Set(previous?.links ?? []);
  // First deploy: snapshot Data/ as the vanilla baseline. On re-deploy the
  // baseline is preserved from the prior manifest (Data/ now includes our links).
  const preExisting = previous?.preExisting ?? (await listRelativeFiles(dataFolder));

  const linkFn = opts.linkFn ?? link;
  const links: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, entry] of index.files) {
    // MO2 Root-Builder: a mod's root/ contents map to the game root, not Data/.
    // Deploying them into Data/root/ would be wrong; skip (deferred — see modbench-4).
    if (relativePath === 'root' || relativePath.startsWith('root/')) continue;

    const outcome = await linkWinner(join(dataFolder, relativePath), entry.winner, previousLinks.has(relativePath), linkFn);
    (outcome === 'linked' ? links : skipped).push(relativePath);
  }

  // Remove prior links whose path is no longer a winner (e.g. a mod was
  // disabled/removed), so a later purge doesn't misfile them as strays.
  const nowLinked = new Set(links);
  for (const relativePath of previousLinks) {
    if (!nowLinked.has(relativePath)) await rm(join(dataFolder, relativePath), { force: true });
  }

  if (skipped.length > 0) {
    reporter.report(
      'warning',
      `${skipped.length} mod file(s) were not deployed — a file already exists in Data/.`,
      skipped.join('\n'),
    );
  }

  const loadOrder = await deployLoadOrder(opts.loadOrder ?? [], reporter);

  const manifest: Manifest = { links, preExisting, loadOrder };
  await writeFile(manifestPath(instanceRoot), JSON.stringify(manifest, null, 2));
}

/** Copy load-order files to their game-read targets. Best-effort: a failure is
 *  reported but does not abort the deploy (the caller must still write the
 *  manifest, or the links it created would be orphaned). Returns the targets
 *  that were written. */
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

async function readManifest(instanceRoot: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath(instanceRoot), 'utf8')) as Manifest;
  } catch {
    return null; // absent → nothing deployed
  }
}

export async function purge(
  instanceRoot: string,
  gameDirectory: GameDirectory,
  reporter: Reporter,
): Promise<void> {
  const manifest = await readManifest(instanceRoot);
  if (!manifest) return;

  const { dataFolder } = gameDirectory;
  for (const relativePath of manifest.links) {
    await rm(join(dataFolder, relativePath), { force: true }); // tolerate ENOENT
  }
  for (const target of manifest.loadOrder ?? []) {
    await rm(target, { force: true });
  }

  // Anything left in Data/ that is neither one of our links nor part of the
  // vanilla baseline is a runtime output (F4SE logs, MCM INI writes). Preserve
  // it by moving it into the instance's overwrite/ (sibling of mods/, per MO2).
  const kept = new Set([...manifest.links, ...manifest.preExisting]);
  const unmoved: string[] = [];
  for (const relativePath of await listRelativeFiles(dataFolder)) {
    if (kept.has(relativePath)) continue;
    const from = join(dataFolder, relativePath);
    const to = join(instanceRoot, 'overwrite', relativePath);
    try {
      await mkdir(dirname(to), { recursive: true });
      await moveFile(from, to);
    } catch (err) {
      // Don't abort the rest of the purge over one stubborn file — collect and
      // surface it (ADR-0026 integrity: a file left in Data/ must not be silent).
      unmoved.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

/** Move a file, falling back to copy+delete across volumes (rename's EXDEV). */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Remove now-empty directories under `root` (root itself is kept). */
async function pruneEmptyDirs(root: string): Promise<void> {
  for (const dirent of await readdir(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(root, dirent.name);
    await pruneEmptyDirs(dir);
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  }
}
