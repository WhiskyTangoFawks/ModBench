// A new target is one rename (ADR-0015 invariant 2); an upgrade is never renamed away, so its
// identity and every watcher armed on it survive the release.

import { basename } from 'node:path';
import { detectRoot } from './detectRoot';
import { extractArchive, type Runner } from './extractArchive';
import { markDownloadInstalled } from './installedMark';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import type { InstalledFileId, InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** What install reaches the instance through. */
export interface InstallAccess {
  readonly instanceRoot: string;
  readonly adapter: InstanceAdapter;
}

/** For a manual local install only `installationFile` is typically known; the rest arrives from a
 *  Nexus archive's download identity. */
export interface InstallMeta {
  modid?: string;
  version?: string;
  installationFile?: string;
  installedFiles?: readonly InstalledFileId[];
}

/** The archive extensions install can extract — its one export about which files it takes.
 *  Every picker and the Downloads view read this list, compared case-insensitively. */
export const ARCHIVE_EXTENSIONS = ['zip', '7z', 'rar'] as const;

const archiveExtensionPattern = new RegExp(String.raw`\.(${ARCHIVE_EXTENSIONS.join('|')})$`, 'i');

/** Whether install can extract a file of this name. */
export function isArchiveName(name: string): boolean {
  return archiveExtensionPattern.test(name);
}

/** What a new mod is called before the user says otherwise: the archive's own name, stripped of
 *  the extension install knows how to extract. */
export function defaultModName(archivePath: string): string {
  return basename(archivePath).replace(archiveExtensionPattern, '');
}

/** What a new mod installed from a folder is called before the user says otherwise: the
 *  folder's own name. */
export function defaultModNameForFolder(folder: string): string {
  return basename(folder);
}

/** Install's refusal when a new mod's folder is already there, shared with the name prompt so
 *  both readings of the same collision say the same thing. */
export function modNameCollisionRefusal(name: string): string {
  return `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;
}

/** Why a new mod may not take `name`: a folder already holds a mod of that name, matched as the
 *  instance matches names. Undefined for a free name, or a blank one. */
export async function installNameRefusal(access: InstallAccess, name: string): Promise<string | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const holding = await access.adapter.entryFolder({ kind: 'mod', name: trimmed });
  return holding === undefined ? undefined : modNameCollisionRefusal(trimmed);
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
  /** Extraction runner; defaults to spawning a system 7-Zip. */
  run?: Runner;
  /** The download's Nexus identity, when installing from one — meta.ini's `installedFiles`
   *  entry, so the next upgrade over this folder can pre-select with certainty. */
  modID?: string;
  fileID?: string;
  version?: string;
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
  if (errnoCode(err) === 'EXDEV') {
    return {
      applied: false,
      refusal: `Cannot install "${name}": the staging folder and mods/ are on different drives, so the mod folder cannot be moved into place in one step.`,
    };
  }
  return refuse(err);
}

// An upgrade keeps the mod's repository and its plugin source (mods.md, What install does, story 3).
const KEPT_BY_UPGRADE = new Set(['.git', '.gitignore', 'source']);

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
  access: InstallAccess, target: InstallTarget, stagedRoot: string, meta: InstallMeta, isFomod: boolean, gameName: string,
): Promise<InstallCommandResult> {
  const { name } = target;
  const { adapter } = access;
  return withInstallLock(access.instanceRoot, async (): Promise<InstallCommandResult> => {
    const holding = await adapter.entryFolder({ kind: 'mod', name });
    const refusal = mismatchRefusal(target, holding !== undefined);
    if (refusal) return { applied: false, refusal };
    const keys = { gameName, ...meta };
    try {
      if (target.kind === 'new') {
        await adapter.landNewMod(name, stagedRoot, keys);
        return { applied: true, wrote: true, isFomod };
      }
      try {
        await adapter.upgradeMod(name, stagedRoot, keys, (entry) => KEPT_BY_UPGRADE.has(entry));
      } catch (err) {
        return { applied: false, refusal: `Upgrading "${name}" failed and was not rolled back: ${errorMessage(err)}` };
      }
      return { applied: true, wrote: true, isFomod };
    } catch (err) {
      return crossVolumeOrGenericRefusal(err, name);
    }
  });
}

// Landing renames the mod root out of the staging folder; whatever is left there goes.
async function withStaging<T>(
  access: InstallAccess, stage: () => Promise<string>, use: (staging: string) => Promise<T>,
): Promise<T> {
  const staging = await stage();
  try {
    return await use(staging);
  } finally {
    await access.adapter.removeStagingFolder(staging);
  }
}

async function landDetected(
  access: InstallAccess, target: InstallTarget, staging: string, meta: InstallMeta, gameName: string,
): Promise<InstallCommandResult> {
  const { sourceDir, isFomod } = await detectRoot(access.adapter, staging);
  return landStagedMod(access, target, sourceDir, meta, isFomod, gameName);
}

function metaFor(base: InstallMeta, opts: InstallOptions): InstallMeta {
  const installedFiles = opts.modID && opts.fileID ? [{ modid: opts.modID, fileid: opts.fileID }] : undefined;
  return { ...base, modid: opts.modID ?? base.modid, version: opts.version ?? base.version, installedFiles };
}

/** Extracts into staging and moves the detected mod root in, then marks the downloaded file the
 *  archive is, if it is one — a failed mark is reported beside the landed install, never instead
 *  of it. */
export async function installFromArchive(
  access: InstallAccess, target: InstallTarget, archivePath: string, opts: InstallOptions,
): Promise<InstallCommandResult> {
  try {
    const meta = metaFor({ installationFile: basename(archivePath) }, opts);
    const outcome = await withStaging(access, () => access.adapter.stagingFolder(), async (staging) => {
      await extractArchive(archivePath, staging, opts.run);
      return landDetected(access, target, staging, meta, opts.gameName);
    });
    if (!outcome.applied) return outcome;
    const downloaded = await access.adapter.downloadedFileAt(archivePath);
    if (downloaded === undefined) return outcome;
    const marked = await markDownloadInstalled(access.adapter, downloaded);
    return marked.applied ? outcome : { ...outcome, downloadRefusal: marked.refusal };
  } catch (err) {
    return refuse(err);
  }
}

/** Stages a copy of the folder: the source belongs to the user, so it is never the thing renamed
 *  away. */
export async function installFromFolder(
  access: InstallAccess, target: InstallTarget, folderPath: string, opts: InstallOptions,
): Promise<InstallCommandResult> {
  try {
    return await withStaging(
      access, () => access.adapter.stagingFolderOf(folderPath),
      (staging) => landDetected(access, target, staging, metaFor({}, opts), opts.gameName),
    );
  } catch (err) {
    return refuse(err);
  }
}
