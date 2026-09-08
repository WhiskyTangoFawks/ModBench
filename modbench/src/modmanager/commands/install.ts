// Installing a mod is one rename (ADR-0047 point 6). The folder appears under mods/ complete,
// meta.ini included, and its modlist.txt line comes from the mods watcher adopting an unlisted
// folder — never from here.

import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { detectRoot } from '../install/detectRoot';
import { extractArchive, type Runner } from '../install/extractArchive';
import type { InstallMeta } from '../model';
import { writeMetaIni } from '../mo2/metaIni';
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
}

// Beside mods/ rather than inside it: same volume, so the rename is atomic, and outside every
// watcher's glob, so nothing ever observes the half-built tree.
const STAGING_PREFIX = '.medit-install-';

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// Serialized per instance root: the collision check and the rename must not interleave with
// another install, or two of the same name both pass the check.
const installQueues = new Map<string, Promise<unknown>>();

function withInstallLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = installQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  installQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

// meta.ini is written into the staged tree first, so the folder is never seen without it. A
// cross-volume staging area is refused rather than copied, which would land the mod in pieces.
function landStagedMod(
  instanceRoot: string, name: string, stagedRoot: string, meta: InstallMeta, isFomod: boolean,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<InstallCommandResult> {
  return withInstallLock(instanceRoot, async (): Promise<InstallCommandResult> => {
    const modsDir = join(instanceRoot, 'mods');
    const modDir = join(modsDir, name);
    try {
      if (await exists(modDir)) return { applied: false, refusal: `A mod named "${name}" already exists.` };
      const gameName = readGameName(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8'));
      await writeFile(join(stagedRoot, 'meta.ini'), writeMetaIni({ gameName, ...meta }));
      await mkdir(modsDir, { recursive: true });
      await renameFn(stagedRoot, modDir);
      return { applied: true, wrote: true, isFomod };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        return {
          applied: false,
          refusal: `Cannot install "${name}": the staging folder and mods/ are on different drives, so the mod folder cannot be moved into place in one step.`,
        };
      }
      return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
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
        instanceRoot, name, sourceDir, { installationFile: basename(archivePath) }, isFomod,
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
      return landStagedMod(instanceRoot, name, staging, {}, isFomod, opts.renameFn ?? rename);
    });
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}
