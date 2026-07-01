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
  /** Insert a new enabled separator immediately after `afterEntryName` (mod or separator).
   *  When `afterEntryName` is a separator, inserts after its last child. */
  insertSeparator(name: string, afterEntryName: string): Promise<void>;
  renameSeparator(oldName: string, newName: string): Promise<void>;
  deleteSeparator(name: string): Promise<void>;
  /** Move `modName` to the end of `separatorName`'s section, or to the ungrouped
   *  section (before the first separator) when `separatorName` is null. */
  moveModToSeparator(modName: string, separatorName: string | null): Promise<void>;
  /** Remove the mod from modlist.txt and delete its mods/<name>/ directory. */
  removeMod(modName: string): Promise<void>;
  /** Move a separator and all its children as a block to entry-index `toIndex`. */
  reorderSeparatorBlock(separatorName: string, toIndex: number): Promise<void>;
  /** Nexus Mods game slug (e.g. "fallout4") for constructing mod page URLs. */
  getNexusSlug(): Promise<string>;
  listProfiles(): Promise<string[]>;
  getActiveProfile(): Promise<string>;
  setActiveProfile(name: string): Promise<void>;
  /** plugins.txt load order, read-only (the Plugin List view owns plugin order). */
  readPluginOrder(): Promise<string[]>;
}
