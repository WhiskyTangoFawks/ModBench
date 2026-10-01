// A release is extracted inside the mod's own folder and nowhere else. An upgrade keeps its folder,
// so its identity and every watcher armed on it survive the release.

import { basename } from 'node:path';
import { detectRoot } from './detectRoot';
import { extractArchive, type Runner } from './extractArchive';
import { markDownloadInstalled } from './installedMark';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import {
  modNameTakenRefusal, newModNameRefusal, type InstalledFileId, type InstanceAdapter, type ModExtraction, type NewModExtraction, type UpgradeExtraction,
} from '../instanceAdapter/instanceAdapter';

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

/** Why a new mod may not take `name`, in the words install refuses it with. */
export const installNameRefusal = (access: Pick<InstallAccess, 'adapter'>, name: string): Promise<string | undefined> =>
  newModNameRefusal(access.adapter, name);

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

// Serialized per instance root: the collision check and the folder's making must not interleave
// with another install, or two of the same name both pass the check.
const installQueues = new Map<string, Promise<unknown>>();

function withInstallLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = installQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  installQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

// The folder can appear or vanish between the caller's decision and this check — the mod manager,
// xEdit or the user own it too — so a claim that disagrees with disk is refused, never
// reinterpreted.
function mismatchRefusal(target: InstallTarget, targetExists: boolean): string | undefined {
  if (target.kind === 'new' && targetExists) return modNameTakenRefusal(target.name);
  if (target.kind === 'upgrade' && !targetExists) {
    return `Cannot upgrade "${target.name}": there is no folder by that name under mods/.`;
  }
  return undefined;
}

type Opened =
  | { kind: 'new'; extraction: NewModExtraction }
  | { kind: 'upgrade'; extraction: UpgradeExtraction };

async function settle(
  opened: Opened, name: string, root: string, meta: InstallMeta, isFomod: boolean, gameName: string,
): Promise<InstallCommandResult> {
  const keys = { gameName, ...meta };
  if (opened.kind === 'new') {
    await opened.extraction.land(root, keys);
    return { applied: true, wrote: true, isFomod };
  }
  let landed;
  try {
    landed = await opened.extraction.land(root, keys);
  } catch (err) {
    return { applied: false, refusal: `Upgrading "${name}" failed partway and was not rolled back: ${errorMessage(err)}` };
  }
  if (landed.refused) {
    return {
      applied: false,
      refusal: `Cannot upgrade "${name}": the release holds "${landed.repositoryOrPluginSourceEntry}", which is the mod's own repository or plugin source.`,
    };
  }
  return { applied: true, wrote: true, isFomod };
}

function extractAndLand(
  access: InstallAccess, target: InstallTarget, fill: (extraction: ModExtraction) => Promise<void>, meta: InstallMeta, gameName: string,
): Promise<InstallCommandResult> {
  const { adapter } = access;
  const { name } = target;
  return withInstallLock(access.instanceRoot, async (): Promise<InstallCommandResult> => {
    const holding = await adapter.entryFolder({ kind: 'mod', name });
    const refusal = mismatchRefusal(target, holding !== undefined);
    if (refusal) return { applied: false, refusal };
    const opened: Opened = target.kind === 'new'
      ? { kind: 'new', extraction: await adapter.extractNewMod(name) }
      : { kind: 'upgrade', extraction: await adapter.extractUpgrade(name) };
    const { extraction } = opened;
    let outcome: InstallCommandResult;
    try {
      await fill(extraction);
      const { sourceDir, isFomod } = await detectRoot(adapter, extraction.path);
      outcome = await settle(opened, name, sourceDir, meta, isFomod, gameName);
    } catch (err) {
      outcome = refuse(err);
    }
    if (outcome.applied) return outcome;
    try {
      await extraction.abandon();
    } catch (err) {
      return { applied: false, refusal: `${outcome.refusal} Removing what the install left behind failed too: ${errorMessage(err)}` };
    }
    return outcome;
  });
}

function metaFor(base: InstallMeta, opts: InstallOptions): InstallMeta {
  const installedFiles = opts.modID && opts.fileID ? [{ modid: opts.modID, fileid: opts.fileID }] : undefined;
  return { ...base, modid: opts.modID ?? base.modid, version: opts.version ?? base.version, installedFiles };
}

/** Extracts into the mod's own folder, then marks the downloaded file the archive is, if it is
 *  one — a failed mark is reported beside the landed install, never instead of it. */
export async function installFromArchive(
  access: InstallAccess, target: InstallTarget, archivePath: string, opts: InstallOptions,
): Promise<InstallCommandResult> {
  try {
    const meta = metaFor({ installationFile: basename(archivePath) }, opts);
    const outcome = await extractAndLand(access, target, (extraction) => extractArchive(archivePath, extraction.path, opts.run), meta, opts.gameName);
    if (!outcome.applied) return outcome;
    const downloaded = await access.adapter.downloadedFileAt(archivePath);
    if (downloaded === undefined) return outcome;
    const marked = await markDownloadInstalled(access.adapter, downloaded);
    return marked.applied ? outcome : { ...outcome, downloadRefusal: marked.refusal };
  } catch (err) {
    return refuse(err);
  }
}

/** Copies the folder in: the source belongs to the user, so it is never the thing moved. */
export async function installFromFolder(
  access: InstallAccess, target: InstallTarget, folderPath: string, opts: InstallOptions,
): Promise<InstallCommandResult> {
  try {
    return await extractAndLand(access, target, (extraction) => extraction.copyIn(folderPath), metaFor({}, opts), opts.gameName);
  } catch (err) {
    return refuse(err);
  }
}
