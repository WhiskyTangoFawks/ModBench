// A new target is one rename (ADR-0015 invariant 2); an upgrade is never renamed away, so its
// identity and every watcher armed on it survive the release.

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, cp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { detectRoot } from '../install/detectRoot';
import { extractArchive, type Runner } from '../install/extractArchive';
import type { InstallMeta } from '../model';
import { modNameCollisionRefusal } from '../modNameCollision';
import { MOD_META_FILE_NAME, modsDir as modsDirOf, settingsFile } from '../mo2/layout';
import { parseMetaIni, setOwnedKeysInText, writeMetaIni, type OwnedMetaKeys } from '../mo2/metaIni';
import { readGameName } from '../mo2/modOrganizerIni';

/** Which install this is, settled by the caller: the folder on disk is checked against this
 *  claim, never consulted to decide it. */
export type InstallTarget =
  | { kind: 'new'; name: string }
  | { kind: 'upgrade'; name: string };

/** The same choice before a new mod has a name — what the Downloads pick yields, which the
 *  install command's name prompt completes. */
export type InstallChoice =
  | { kind: 'new' }
  | { kind: 'upgrade'; name: string };

/** `isFomod` reports a scripted installer whose files landed as-is: the caller warns, the
 *  install still stands. */
export type InstallCommandResult =
  | { applied: true; wrote: boolean; isFomod: boolean }
  | { applied: false; refusal: string };

export interface InstallOptions {
  /** Rename primitive; defaults to fs.rename. Injectable so the cross-volume refusal is
   *  testable without a real second volume, the seam `PurgeOptions.renameFn` already opens. */
  renameFn?: (from: string, to: string) => Promise<void>;
  /** Extraction runner; defaults to spawning a system 7-Zip. */
  run?: Runner;
  /** The download's Nexus identity, when installing from one — meta.ini's `installedFiles`
   *  entry, so the next upgrade over this folder can pre-select with certainty. */
  modID?: string;
  fileID?: string;
  version?: string;
}

// Beside mods/ rather than inside it: same volume, so the rename is atomic, and outside every
// watcher's glob, so nothing ever observes the half-built tree.
const STAGING_PREFIX = '.medit-install-';

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

// Serialized per instance root: the collision check and the rename must not interleave with
// another install, or two of the same name both pass the check.
const installQueues = new Map<string, Promise<unknown>>();

function withInstallLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = installQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  installQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

function crossVolumeOrGenericRefusal(err: unknown, name: string): InstallCommandResult {
  if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
    return {
      applied: false,
      refusal: `Cannot install "${name}": the staging folder and mods/ are on different drives, so the mod folder cannot be moved into place in one step.`,
    };
  }
  return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
}

// meta.ini is written into the staged tree first, so the folder is never seen without it, then
// the whole tree lands in one rename — the folder appears complete in one filesystem event.
async function landNewMod(
  modsDir: string, modDir: string, stagedRoot: string, keys: OwnedMetaKeys,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<void> {
  await writeFile(join(stagedRoot, MOD_META_FILE_NAME), writeMetaIni(keys));
  await mkdir(modsDir, { recursive: true });
  await renameFn(stagedRoot, modDir);
}

// An owned key the identity does not supply falls back to the old meta.ini's own value: the
// merge with what was already there is this caller's job, not `setOwnedKeysInText`'s.
function keysForUpgrade(gameName: string, meta: InstallMeta, oldMetaText: string): OwnedMetaKeys {
  const old = parseMetaIni(oldMetaText);
  return {
    gameName,
    modid: meta.modid ?? old.nexusId,
    version: meta.version ?? old.version,
    installationFile: meta.installationFile ?? old.archiveFilename,
    installedFiles: meta.installedFiles ?? old.installedFiles,
  };
}

// Every entry but `.git` is removed, the staged tree's entries move in, and meta.ini is set
// through the existing-text write, so a foreign key never moves. Nothing past the first removal
// is rolled back on failure.
async function landUpgrade(
  modDir: string, stagedRoot: string, gameName: string, meta: InstallMeta,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const oldMetaText = await readTextOrEmpty(join(modDir, MOD_META_FILE_NAME));
  const keys = keysForUpgrade(gameName, meta, oldMetaText);
  for (const entry of await readdir(modDir)) {
    if (entry === '.git') continue;
    await rm(join(modDir, entry), { recursive: true, force: true });
  }
  for (const entry of await readdir(stagedRoot)) {
    await renameFn(join(stagedRoot, entry), join(modDir, entry));
  }
  await writeFile(join(modDir, MOD_META_FILE_NAME), setOwnedKeysInText(oldMetaText, keys));
}

// The folder can appear or vanish between the caller's decision and this check — MO2, xEdit or
// the user own it too — so a claim that disagrees with disk is refused, never reinterpreted.
function mismatchRefusal(target: InstallTarget, targetExists: boolean): string | undefined {
  if (target.kind === 'new' && targetExists) return modNameCollisionRefusal(target.name);
  if (target.kind === 'upgrade' && !targetExists) {
    return `Cannot upgrade "${target.name}": there is no folder by that name under mods/.`;
  }
  return undefined;
}

function landStagedMod(
  instanceRoot: string, target: InstallTarget, stagedRoot: string, meta: InstallMeta, isFomod: boolean,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<InstallCommandResult> {
  const { name } = target;
  return withInstallLock(instanceRoot, async (): Promise<InstallCommandResult> => {
    const modsDir = modsDirOf(instanceRoot);
    const modDir = join(modsDir, name);
    const refusal = mismatchRefusal(target, await exists(modDir));
    if (refusal) return { applied: false, refusal };
    try {
      const gameName = readGameName(await readFile(settingsFile(instanceRoot), 'utf8'));
      if (target.kind === 'new') {
        await landNewMod(modsDir, modDir, stagedRoot, { gameName, ...meta }, renameFn);
        return { applied: true, wrote: true, isFomod };
      }
      try {
        await landUpgrade(modDir, stagedRoot, gameName, meta, renameFn);
      } catch (err) {
        return {
          applied: false,
          refusal: `Upgrading "${name}" failed partway and was not rolled back: ${
            err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { applied: true, wrote: true, isFomod };
    } catch (err) {
      return crossVolumeOrGenericRefusal(err, name);
    }
  });
}

async function withStaging<T>(instanceRoot: string, use: (staging: string) => Promise<T>): Promise<T> {
  const staging = await mkdtemp(join(instanceRoot, STAGING_PREFIX));
  try {
    return await use(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function metaFor(base: InstallMeta, opts: InstallOptions): InstallMeta {
  const installedFiles = opts.modID && opts.fileID ? [{ modid: opts.modID, fileid: opts.fileID }] : undefined;
  return { ...base, modid: opts.modID ?? base.modid, version: opts.version ?? base.version, installedFiles };
}

/** Extracts into staging and moves the detected mod root in. `installationFile` records which
 *  download it came from, which is what marks that download installed. */
export async function installFromArchive(
  instanceRoot: string, target: InstallTarget, archivePath: string, opts: InstallOptions = {},
): Promise<InstallCommandResult> {
  try {
    return await withStaging(instanceRoot, async (staging) => {
      await extractArchive(archivePath, staging, opts.run);
      const { sourceDir, isFomod } = await detectRoot(staging);
      return landStagedMod(
        instanceRoot, target, sourceDir, metaFor({ installationFile: basename(archivePath) }, opts), isFomod,
        opts.renameFn ?? rename);
    });
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** Copies the folder into staging first: the source belongs to the user, so it is never the
 *  thing renamed away. */
export async function installFromFolder(
  instanceRoot: string, target: InstallTarget, folderPath: string, opts: InstallOptions = {},
): Promise<InstallCommandResult> {
  try {
    return await withStaging(instanceRoot, async (staging) => {
      const { sourceDir, isFomod } = await detectRoot(folderPath);
      await cp(sourceDir, staging, { recursive: true });
      return landStagedMod(instanceRoot, target, staging, metaFor({}, opts), isFomod, opts.renameFn ?? rename);
    });
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}
