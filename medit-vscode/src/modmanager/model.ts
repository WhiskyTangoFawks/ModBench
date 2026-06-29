// In-memory modlist model. The MO2 source (mo2/Mo2ModlistSource.ts) reads an
// instance into ModlistEntry[] and writes mutations back byte-faithfully via the
// pure text transforms in mo2/. These types are a read-view over the raw files;
// they never own serialization.

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

/** Persistence over an MO2 instance for the active profile. Top = highest priority. */
export interface IModlistSource {
  readModlist(): Promise<ModlistEntry[]>;
  setEnabled(modName: string, enabled: boolean): Promise<void>;
  reorder(modName: string, toIndex: number): Promise<void>;
  listProfiles(): Promise<string[]>;
  getActiveProfile(): Promise<string>;
  setActiveProfile(name: string): Promise<void>;
  /** plugins.txt load order, read-only (the Plugin List view owns plugin order). */
  readPluginOrder(): Promise<string[]>;
}
