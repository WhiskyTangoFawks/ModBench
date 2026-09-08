// A read-view over the raw MO2 files: these types never own serialization, which stays with
// the byte-faithful text transforms in mo2/.

export interface Mod {
  kind: 'mod';
  name: string;
  enabled: boolean;
  /** From mods/<name>/meta.ini; undefined when absent or empty. */
  version?: string;
  nexusId?: string;
  archiveFilename?: string;
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

/** For a manual local install only `installationFile` is typically known; Nexus id and
 *  version arrive with the download flow. */
export interface InstallMeta {
  modid?: string;
  version?: string;
  installationFile?: string;
}
