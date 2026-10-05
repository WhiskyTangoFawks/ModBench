// A downloaded file's row: its status is the mods' answer, and its metadata's claim only where no
// mod names it.

import type { DownloadedFile, DownloadStatus } from '../instanceAdapter/instanceAdapter';

export interface DownloadRow {
  name: string;
  /** The metadata's `name` when non-empty, else the raw filename — never blank. */
  displayName: string;
  status: DownloadStatus;
  size: number;
  mtimeMs: number;
  hasMeta: boolean;
  /** A separate axis from Status. */
  excluded: boolean;
  /** Nexus mod id; absent when the metadata names none. */
  modID?: string;
  /** Nexus file id: the upgrade pick's precise match, sharper than modID's mod-level one. */
  fileID?: string;
  version?: string;
  /** The mod's own name, distinct from the file's `displayName`. */
  modName?: string;
  gameName?: string;
  author?: string;
}

/** A downloaded file's row with the two paths a view opens or reveals, so that no view joins one. */
export interface DownloadFile extends DownloadRow {
  readonly path: string;
  readonly sidecarPath: string;
}

// Archive filenames come from two places and are compared, never displayed, so they are folded: a
// Windows filename is case-insensitive.
export const archiveKey = (filename: string): string => filename.toLowerCase();

/** Which mods each download was installed into, keyed by the download's folded filename: the
 *  reverse of every mod's installation file, many to many. A mod naming no file claims nothing,
 *  which is unknown rather than an uninstall. */
export function modsByInstallationFile(
  mods: readonly { name: string; archiveFilename?: string }[],
): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const mod of mods) {
    if (!mod.archiveFilename) continue;
    const key = archiveKey(mod.archiveFilename);
    byFile.set(key, [...(byFile.get(key) ?? []), mod.name]);
  }
  return byFile;
}

/** Excluded rows are built and flagged, never filtered — filtering is a view concern. `installedInto`
 *  is what makes a row Installed; unclaimed, the metadata's own claim decides Downloaded vs.
 *  Uninstalled. */
export function buildDownloadRows(
  files: readonly DownloadedFile[], installedInto: ReadonlyMap<string, readonly string[]>,
): DownloadFile[] {
  const rows = files.map((file): DownloadFile => {
    const meta = file.meta;
    // Installed is the mods' own answer, never the metadata's: a claimed install outlives the mod
    // it names, so an uncorroborated installed and uninstalled read alike.
    let status: DownloadStatus = meta === undefined || meta.status === 'Downloaded' ? 'Downloaded' : 'Uninstalled';
    if (installedInto.has(archiveKey(file.name))) status = 'Installed';
    return {
      name: file.name,
      // The reference tool's displayNameByInfo (downloadmanager.cpp:1410): absent and empty alike
      // fall back.
      displayName: meta?.name || file.name,
      status,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hasMeta: meta !== undefined,
      excluded: meta?.excluded ?? false,
      modID: meta?.modID,
      fileID: meta?.fileID,
      version: meta?.version,
      modName: meta?.modName,
      gameName: meta?.gameName,
      author: meta?.author,
      path: file.path,
      sidecarPath: file.metaPath,
    };
  });
  // Newest first, the reference tool's own arrival order; which column the tree sorts by is the
  // view's.
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
