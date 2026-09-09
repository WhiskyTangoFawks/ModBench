// A read-view over the raw MO2 files: these types never own serialization, which stays with
// the byte-faithful text transforms in mo2/.

/** One meta.ini `[installedFiles]` entry — a Nexus mod/file id pair MO2 recorded as
 *  installed. Field names match the array's own (lowercase) keys. */
export interface InstalledFileId {
  modid: string;
  fileid: string;
}

export interface Mod {
  kind: 'mod';
  name: string;
  enabled: boolean;
  /** From mods/<name>/meta.ini; undefined when absent or empty. */
  version?: string;
  nexusId?: string;
  archiveFilename?: string;
  /** meta.ini's `[installedFiles]` array, in index order; undefined when the
   *  section is absent — the upgrade pick's exact-file match. */
  installedFiles?: readonly InstalledFileId[];
}

export interface Separator {
  kind: 'separator';
  /** Display name, with the trailing `_separator` marker stripped. */
  name: string;
  enabled: boolean;
}

export type ModlistEntry = Mod | Separator;

/** A single plugins.txt line (a plugin file), in Plugin load order. The `*`
 *  prefix (MO2's enabled marker) is modelled as `enabled`; the marker itself is
 *  never surfaced in `name`. Distinct from a Mod: plugins.txt has no separators. */
export interface PluginEntry {
  name: string;
  enabled: boolean;
}

/** For a manual local install only `installationFile` is typically known; the rest arrives
 *  from a Nexus archive's download identity. */
export interface InstallMeta {
  modid?: string;
  version?: string;
  installationFile?: string;
  installedFiles?: readonly InstalledFileId[];
}
