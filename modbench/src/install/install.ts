// A new target is one rename (ADR-0015 invariant 2); an upgrade is never renamed away, so its
// identity and every watcher armed on it survive the release.

import { basename, join } from 'node:path';
import { detectRoot } from './detectRoot';
import { extractArchive, type Runner } from './extractArchive';
import { markDownloadInstalled } from './downloadSidecar';
import {
  MOD_META_FILE_NAME, parseMetaIni, setOwnedKeysInText, writeMetaIni, type InstalledFileId, type OwnedMetaKeys,
} from '../mo2Codecs/metaIni';
import { downloadFile, modsDir as modsDirOf } from '../mo2Files/layout';
import { copyTree, ensureDir, exists, get, listDir, makeTempDir, remove, rename, write } from '../mo2Files/files';
import { errnoCode } from '../ports/errno';

/** For a manual local install only `installationFile` is typically known; the rest arrives from a
 *  Nexus archive's download identity. */
export interface InstallMeta {
  modid?: string;
  version?: string;
  installationFile?: string;
  installedFiles?: readonly InstalledFileId[];
}

/** What a new mod is called before the user says otherwise: the archive's own name, stripped of
 *  the extension install knows how to extract. */
export function defaultModName(archivePath: string): string {
  return basename(archivePath).replace(/\.(zip|7z|rar)$/i, '');
}

/** Install's refusal when a new mod's folder is already there, shared with the name prompt so
 *  both readings of the same collision say the same thing. */
export function modNameCollisionRefusal(name: string): string {
  return `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;
}

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
 *  install still stands. `downloadRefusal` is the bookkeeping half failing over a mod that did
 *  land, so it is never a refusal of the install. */
export type InstallCommandResult =
  | { applied: true; wrote: boolean; isFomod: boolean; downloadRefusal?: string }
  | { applied: false; refusal: string };

export interface InstallOptions {
  /** ModOrganizer.ini's `gameName`, handed in from the value: meta.ini's own key, so nothing
   *  here re-reads the ini. */
  gameName: string;
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
  if (errnoCode(err) === 'EXDEV') {
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
  await write(join(stagedRoot, MOD_META_FILE_NAME), writeMetaIni(keys));
  await ensureDir(modsDir);
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
  const oldMetaText = await get(join(modDir, MOD_META_FILE_NAME), '');
  const keys = keysForUpgrade(gameName, meta, oldMetaText);
  for (const entry of await listDir(modDir)) {
    if (entry.name === '.git') continue;
    await remove(join(modDir, entry.name));
  }
  for (const entry of await listDir(stagedRoot)) {
    await renameFn(join(stagedRoot, entry.name), join(modDir, entry.name));
  }
  await write(join(modDir, MOD_META_FILE_NAME), setOwnedKeysInText(oldMetaText, keys));
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
  gameName: string, renameFn: (from: string, to: string) => Promise<void>,
): Promise<InstallCommandResult> {
  const { name } = target;
  return withInstallLock(instanceRoot, async (): Promise<InstallCommandResult> => {
    const modsDir = modsDirOf(instanceRoot);
    const modDir = join(modsDir, name);
    const refusal = mismatchRefusal(target, await exists(modDir));
    if (refusal) return { applied: false, refusal };
    try {
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
  const staging = await makeTempDir(join(instanceRoot, STAGING_PREFIX));
  try {
    return await use(staging);
  } finally {
    await remove(staging);
  }
}

function metaFor(base: InstallMeta, opts: InstallOptions): InstallMeta {
  const installedFiles = opts.modID && opts.fileID ? [{ modid: opts.modID, fileid: opts.fileID }] : undefined;
  return { ...base, modid: opts.modID ?? base.modid, version: opts.version ?? base.version, installedFiles };
}

/** Extracts into staging and moves the detected mod root in, then marks the download it came
 *  from installed — the mod is landed by then, so a failed mark is reported beside it, never
 *  instead of it. */
export async function installFromArchive(
  instanceRoot: string, target: InstallTarget, archivePath: string, opts: InstallOptions,
): Promise<InstallCommandResult> {
  try {
    const outcome = await withStaging(instanceRoot, async (staging) => {
      await extractArchive(archivePath, staging, opts.run);
      const { sourceDir, isFomod } = await detectRoot(staging);
      return landStagedMod(
        instanceRoot, target, sourceDir, metaFor({ installationFile: basename(archivePath) }, opts), isFomod,
        opts.gameName, opts.renameFn ?? rename);
    });
    if (!outcome.applied) return outcome;
    return { ...outcome, ...(await markedInstalled(instanceRoot, archivePath)) };
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}

// Only an archive that IS a download has a sidecar to mark; one the user picked from anywhere
// else has none, and writing a `.meta` into downloads/ for it would invent a row.
async function markedInstalled(
  instanceRoot: string, archivePath: string,
): Promise<{ downloadRefusal?: string }> {
  const name = basename(archivePath);
  if (archivePath !== downloadFile(instanceRoot, name)) return {};
  const marked = await markDownloadInstalled(instanceRoot, name);
  return marked.applied ? {} : { downloadRefusal: marked.refusal };
}

/** Copies the folder into staging first: the source belongs to the user, so it is never the
 *  thing renamed away. */
export async function installFromFolder(
  instanceRoot: string, target: InstallTarget, folderPath: string, opts: InstallOptions,
): Promise<InstallCommandResult> {
  try {
    return await withStaging(instanceRoot, async (staging) => {
      const { sourceDir, isFomod } = await detectRoot(folderPath);
      await copyTree(sourceDir, staging);
      return landStagedMod(
        instanceRoot, target, staging, metaFor({}, opts), isFomod, opts.gameName, opts.renameFn ?? rename);
    });
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
}
