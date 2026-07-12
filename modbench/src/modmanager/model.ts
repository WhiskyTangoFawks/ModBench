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

/** A single plugins.txt line (a plugin file), in Plugin load order. The `*`
 *  prefix (MO2's enabled marker) is modelled as `enabled`; the marker itself is
 *  never surfaced in `name`. Distinct from a Mod: plugins.txt has no separators. */
export interface PluginEntry {
  name: string;
  enabled: boolean;
}

/** Metadata known at install time for a new mod's meta.ini. For a manual local
 *  install only `installationFile` is typically known; Nexus id/version arrive
 *  with the download flow (Modbench-7). */
export interface InstallMeta {
  modid?: string;
  version?: string;
  installationFile?: string;
}

/** Persistence over an MO2 instance for the active profile. File order is
 *  winning-first: top of modlist.txt = winning end, bottom = losing end. */
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
  /** Install a new mod: copy `sourceDir`'s contents to mods/<name>/, write its
   *  meta.ini, and insert a disabled line at the winning end (top) of
   *  modlist.txt. Rejects if a mod named `name` already exists. */
  installMod(name: string, sourceDir: string, meta: InstallMeta): Promise<void>;
  /** Move a separator and all its children as a block to entry-index `toIndex`. */
  reorderSeparatorBlock(separatorName: string, toIndex: number): Promise<void>;
  /** Nexus Mods game slug (e.g. "fallout4") for constructing mod page URLs. */
  getNexusSlug(): Promise<string>;
  listProfiles(): Promise<string[]>;
  /** Separator names in file order (winning end / top of file first). */
  listSeparators(): Promise<string[]>;
  getActiveProfile(): Promise<string>;
  setActiveProfile(name: string): Promise<void>;
  /** plugins.txt load order, read-only (the Plugin List view owns plugin order). */
  readPluginOrder(): Promise<string[]>;
  /** plugins.txt load order, enabled-only (the `*`-prefixed lines) — the plugins
   *  that actually load, used to build a `load-explicit` editing session. */
  readEnabledPlugins(): Promise<string[]>;
  /** Set a plugin's enabled state (plugins.txt's `*` marker), byte-faithfully.
   *  Throws if the plugin is absent. */
  setPluginEnabled(pluginName: string, enabled: boolean): Promise<void>;
  /** Move one or more plugins (by name) so the moved block occupies entry-index
   *  `toIndex` among plugins.txt's lines (top = loads first), counting entries
   *  with the moved lines removed. Preserves the moved lines' relative order
   *  regardless of selection contiguity or the order names are given in. Throws
   *  if any name is absent. */
  reorderPlugins(pluginNames: string[], toIndex: number): Promise<void>;
}
