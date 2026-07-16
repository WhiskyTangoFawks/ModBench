// Standalone deployer: hardlinks the merged mod view (the FileConflictIndex
// winner map) into the game directory's Data/, and purges it back out. The
// binary plugins remain the source of truth; a manifest at
// mods/.medit-manifest.json records what we created so purge is exact and
// crash-recovery is self-contained. Native fs.link — no VFS, no P/Invoke.

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

/** readManifest's result: 'absent' (nothing deployed yet) and 'corrupt' (unreadable
 *  or unparseable) are distinct outcomes — conflating them let a corrupt manifest
 *  fall through to "nothing deployed" and re-snapshot Data/ (with our own prior
 *  links still present) as the vanilla baseline. ADR-0026 integrity tier: corrupt
 *  must stop the operation and surface, never silently proceed as absent. */
type ManifestResult =
  | { status: 'absent' }
  | { status: 'corrupt'; error: Error }
  | { status: 'ok'; manifest: Manifest };

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

  const { links, skipped } = await linkWinners(index, dataFolder, previousLinks, opts.linkFn ?? link);
  await removeStaleLinks(dataFolder, previousLinks, links);

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

/** Hardlinks require mods/ and the game directory to share a volume. Reports and
 *  returns false if they don't (ADR-0026 "explicit action failed") — the caller
 *  offers a stock-folder move or symlink fallback; we never silently symlink. */
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

/** Resolve the prior-deploy baseline: our previous links, and the vanilla Data/
 *  snapshot. First deploy snapshots Data/; re-deploy preserves the prior baseline
 *  (Data/ now includes our links, so it must not be re-snapshotted). Returns null
 *  (caller must abort) when the manifest is corrupt — a genuinely-absent manifest
 *  is the only case that snapshots Data/ as vanilla. */
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

/** Manifest links (original-cased) -> folded key -> original-cased path, so a
 *  later casing change (a reorder makes a different-case-variant provider win)
 *  can be detected against the PRIOR casing rather than just the folded key. */
function toFoldedLinkMap(links: string[]): Map<string, string> {
  return new Map(links.map((path) => [foldPath(path), path]));
}

/** Hardlink each winner into Data/, partitioning paths into linked vs skipped.
 *  A prior link is matched by FOLDED key (so a lookup finds it regardless of
 *  casing), but "is this the same link" is judged by EXACT casing — if the
 *  winner's casing changed since the last deploy (e.g. a reorder makes a
 *  different mod, shipping a different-case variant of the same logical file,
 *  win), the old-cased target is a stale file at a path distinct from the new
 *  one on ext4 and must be removed before the new-cased link is created, or it
 *  would be orphaned in Data/ forever (the #128 bug, reproduced via a
 *  different trigger if this weren't handled). */
async function linkWinners(
  index: FileConflictIndex,
  dataFolder: string,
  previousLinks: Map<string, string>,
  linkFn: (source: string, target: string) => Promise<void>,
): Promise<{ links: string[]; skipped: string[] }> {
  const links: string[] = [];
  const skipped: string[] = [];
  for (const entry of index.files) {
    const relativePath = entry.relativePath;
    // MO2 Root-Builder: a mod's root/ contents map to the game root, not Data/.
    // Deploying them into Data/root/ would be wrong; skip (deferred — see modbench-4).
    if (relativePath === 'root' || relativePath.startsWith('root/')) continue;

    const foldedKey = foldPath(relativePath);
    const priorPath = previousLinks.get(foldedKey);
    if (priorPath !== undefined && priorPath !== relativePath) {
      // Casing changed since the last deploy — the old-cased target is a
      // distinct on-disk path from the new one; remove it explicitly.
      await rm(join(dataFolder, priorPath), { force: true });
    }
    const wasPreviouslyLinked = priorPath === relativePath;

    const outcome = await linkWinner(join(dataFolder, relativePath), entry.winner, wasPreviouslyLinked, linkFn);
    (outcome === 'linked' ? links : skipped).push(relativePath);
  }
  return { links, skipped };
}

/** Remove prior links whose folded key is no longer a winner at all (e.g. a
 *  mod was disabled/removed), so a later purge doesn't misfile them as
 *  strays. Distinct from linkWinners' stale-old-casing removal: this is the
 *  "genuinely gone" case, that is the "casing changed" case. */
async function removeStaleLinks(dataFolder: string, previousLinks: Map<string, string>, links: string[]): Promise<void> {
  const nowLinkedFolded = new Set(links.map(foldPath));
  for (const [foldedKey, path] of previousLinks) {
    if (!nowLinkedFolded.has(foldedKey)) await rm(join(dataFolder, path), { force: true });
  }
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

async function readManifest(instanceRoot: string): Promise<ManifestResult> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(instanceRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'corrupt', error: err instanceof Error ? err : new Error(String(err)) };
  }
  try {
    return { status: 'ok', manifest: JSON.parse(raw) as Manifest };
  } catch (err) {
    return { status: 'corrupt', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function reportCorruptManifest(reporter: Reporter, error: Error): void {
  reporter.report(
    'error',
    'The deployment manifest is corrupt and could not be read — aborting to avoid corrupting the vanilla baseline.',
    error.message,
  );
}

/** Resolves the manifest to purge, or null when there's nothing to do: genuinely
 *  absent (silent no-op — nothing was ever deployed) or corrupt (reported on the
 *  integrity tier; the caller must abort without touching Data/ or the manifest
 *  file, which stays on disk as corruption evidence). */
async function resolveManifestForPurge(instanceRoot: string, reporter: Reporter): Promise<Manifest | null> {
  const result = await readManifest(instanceRoot);
  if (result.status === 'corrupt') reportCorruptManifest(reporter, result.error);
  return result.status === 'ok' ? result.manifest : null;
}

export async function purge(
  instanceRoot: string,
  gameDirectory: GameDirectory,
  reporter: Reporter,
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

  // Anything left in Data/ that is neither one of our links nor part of the
  // vanilla baseline is a runtime output (F4SE logs, MCM INI writes). Preserve
  // it by moving it into the instance's overwrite/ (sibling of mods/, per MO2).
  // Compared by folded path: a real on-disk entry's casing must match a kept
  // path only up to case, since Proton/Wine resolves it case-insensitively.
  const keptFolded = new Set([...manifest.links, ...manifest.preExisting].map(foldPath));
  const unmoved: string[] = [];
  for (const relativePath of await listRelativeFiles(dataFolder)) {
    if (keptFolded.has(foldPath(relativePath))) continue;
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
