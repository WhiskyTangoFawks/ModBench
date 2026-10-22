// A downloaded file's row: its status is the mods' answer, and its metadata's claim only where no
// mod names it. It also carries the installed mods the file can upgrade.

import type { DownloadedFile, DownloadedFileStatus, Mod, ModlistEntry } from '../instanceAdapter/instanceAdapter';

export interface DownloadedFileRow {
  name: string;
  /** The metadata's `name` when non-empty, else the raw filename — never blank. */
  displayName: string;
  status: DownloadedFileStatus;
  size: number;
  mtimeMs: number;
  hasMeta: boolean;
  /** A separate axis from Status. */
  excluded: boolean;
  /** Nexus mod id; absent when the metadata names none. */
  modID?: string;
  version?: string;
  /** The mod's own name, distinct from the file's `displayName`. */
  modName?: string;
  gameName?: string;
  author?: string;
  /** The installed mods this file can upgrade, best match first. */
  upgrades: readonly UpgradeCandidate[];
}

/** A downloaded file's row with the two paths a view opens or reveals, so that no view joins one. */
export interface LocatedDownloadedFileRow extends DownloadedFileRow {
  readonly path: string;
  readonly metadataPath: string;
}

// Installation file names come from two places and are compared, never displayed, so they are folded: a
// Windows filename is case-insensitive.
const installationFileKey = (filename: string): string => filename.toLowerCase();

export type UpgradeTier = 'fileId' | 'installationFileName';

export interface UpgradeCandidate {
  readonly modName: string;
  readonly version?: string;
  /** `fileId` beats `installationFileName`; absent, the mod shares only the Nexus mod id. */
  readonly tier?: UpgradeTier;
}

const isFileIdMatch = (mod: Mod, installedKey: string | undefined): boolean =>
  installedKey !== undefined && mod.installedFileKeys?.includes(installedKey) === true;

const isInstallationFileNameMatch = (mod: Mod, downloadedFileName: string): boolean =>
  mod.installationFileName !== undefined && installationFileKey(mod.installationFileName) === installationFileKey(downloadedFileName);

const TIER_RANK: Record<UpgradeTier | 'none', number> = { fileId: 0, installationFileName: 1, none: 2 };

function upgradeCandidates(
  mods: readonly ModlistEntry[],
  downloadedFile: Pick<DownloadedFileRow, 'modID' | 'name'> & { readonly installedKey?: string },
): UpgradeCandidate[] {
  if (!downloadedFile.modID) return [];
  const pool = mods.filter((e): e is Mod => e.kind === 'mod' && e.nexusId === downloadedFile.modID);
  const hasFileIdMatch = pool.some((mod) => isFileIdMatch(mod, downloadedFile.installedKey));
  const tierOf = (mod: Mod): UpgradeTier | undefined => {
    if (isFileIdMatch(mod, downloadedFile.installedKey)) return 'fileId';
    if (!hasFileIdMatch && isInstallationFileNameMatch(mod, downloadedFile.name)) return 'installationFileName';
    return undefined;
  };
  const candidates = pool.map((mod) => ({ modName: mod.name, version: mod.version, tier: tierOf(mod) }));
  return [...candidates].sort((a, b) => TIER_RANK[a.tier ?? 'none'] - TIER_RANK[b.tier ?? 'none']);
}

/** Which mods each downloaded file was installed into, keyed by its folded filename: the
 *  reverse of every mod's installation file name, many to many. A mod naming no file claims nothing,
 *  which is unknown rather than an uninstall. */
export function modsByInstallationFileName(
  mods: readonly { name: string; installationFileName?: string }[],
): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const mod of mods) {
    if (!mod.installationFileName) continue;
    const key = installationFileKey(mod.installationFileName);
    byFile.set(key, [...(byFile.get(key) ?? []), mod.name]);
  }
  return byFile;
}

/** Excluded rows are built and flagged, never filtered — filtering is a view concern. `installedInto`
 *  is what makes a row Installed; unclaimed, the metadata's own claim decides Downloaded vs.
 *  Uninstalled. */
export function buildDownloadedFileRows(
  files: readonly DownloadedFile[], installedInto: ReadonlyMap<string, readonly string[]>, mods: readonly ModlistEntry[],
): LocatedDownloadedFileRow[] {
  return files.map((file): LocatedDownloadedFileRow => {
    const meta = file.meta;
    // Installed is the mods' own answer, never the metadata's: a claimed install outlives the mod
    // it names, so an uncorroborated installed and uninstalled read alike.
    let status: DownloadedFileStatus = meta === undefined || meta.status === 'Downloaded' ? 'Downloaded' : 'Uninstalled';
    if (installedInto.has(installationFileKey(file.name))) status = 'Installed';
    return {
      name: file.name,
      // The reference tool's displayNameByInfo (downloadmanager.cpp:1410): absent and empty alike
      // fall back.
      displayName: meta?.name || file.name,
      status,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hasMeta: meta !== undefined,
      excluded: file.excluded,
      modID: meta?.modID,
      version: meta?.version,
      modName: meta?.modName,
      gameName: meta?.gameName,
      author: meta?.author,
      upgrades: upgradeCandidates(mods, { name: file.name, modID: file.modID, installedKey: meta?.installedKey }),
      path: file.path,
      metadataPath: file.metadataPath,
    };
  });
}
