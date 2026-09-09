// A new target is one rename (ADR-0047 point 6); an existing target is an upgrade, never
// renamed away, so its identity and every watcher armed on it survive the release.

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, cp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { detectRoot } from '../install/detectRoot';
import { extractArchive, type Runner } from '../install/extractArchive';
import type { InstallMeta } from '../model';
import { setOwnedKeysInText, writeMetaIni, type OwnedMetaKeys } from '../mo2/metaIni';
import { readGameName } from '../mo2/modOrganizerIni';

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
  await writeFile(join(stagedRoot, 'meta.ini'), writeMetaIni(keys));
  await mkdir(modsDir, { recursive: true });
  await renameFn(stagedRoot, modDir);
}

// Every entry but `.git` is removed, the staged tree's entries move in, and meta.ini is set
// through the existing-text write, so a foreign key never moves. Nothing past the first removal
// is rolled back on failure.
async function landUpgrade(
  modDir: string, stagedRoot: string, keys: OwnedMetaKeys,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const oldMetaText = await readTextOrEmpty(join(modDir, 'meta.ini'));
  for (const entry of await readdir(modDir)) {
    if (entry === '.git') continue;
    await rm(join(modDir, entry), { recursive: true, force: true });
  }
  for (const entry of await readdir(stagedRoot)) {
    await renameFn(join(stagedRoot, entry), join(modDir, entry));
  }
  await writeFile(join(modDir, 'meta.ini'), setOwnedKeysInText(oldMetaText, keys));
}

function landStagedMod(
  instanceRoot: string, name: string, stagedRoot: string, meta: InstallMeta, isFomod: boolean,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<InstallCommandResult> {
  return withInstallLock(instanceRoot, async (): Promise<InstallCommandResult> => {
    const modsDir = join(instanceRoot, 'mods');
    const modDir = join(modsDir, name);
    const targetExists = await exists(modDir);
    try {
      const gameName = readGameName(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8'));
      const keys: OwnedMetaKeys = { gameName, ...meta };
      if (!targetExists) {
        await landNewMod(modsDir, modDir, stagedRoot, keys, renameFn);
        return { applied: true, wrote: true, isFomod };
      }
      try {
        await landUpgrade(modDir, stagedRoot, keys, renameFn);
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
  return { ...base, modid: opts.modID ?? base.modid, installedFiles };
}

/** Extracts into staging and moves the detected mod root in. `installationFile` records which
 *  download it came from, which is what marks that download installed. */
export async function installFromArchive(
  instanceRoot: string, name: string, archivePath: string, opts: InstallOptions = {},
): Promise<InstallCommandResult> {
  try {
    return await withStaging(instanceRoot, async (staging) => {
      await extractArchive(archivePath, staging, opts.run);
      const { sourceDir, isFomod } = await detectRoot(staging);
      return landStagedMod(
        instanceRoot, name, sourceDir, metaFor({ installationFile: basename(archivePath) }, opts), isFomod,
        opts.renameFn ?? rename);
    });
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** Copies the folder into staging first: the source belongs to the user, so it is never the
 *  thing renamed away. */
export async function installFromFolder(
  instanceRoot: string, name: string, folderPath: string, opts: InstallOptions = {},
): Promise<InstallCommandResult> {
  try {
    return await withStaging(instanceRoot, async (staging) => {
      const { sourceDir, isFomod } = await detectRoot(folderPath);
      await cp(sourceDir, staging, { recursive: true });
      return landStagedMod(instanceRoot, name, staging, metaFor({}, opts), isFomod, opts.renameFn ?? rename);
    });
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}
