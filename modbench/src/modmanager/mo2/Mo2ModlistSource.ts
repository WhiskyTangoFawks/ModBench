import { readFile, writeFile, readdir, rm, cp, access } from 'node:fs/promises'; // access used by exists()
import { join } from 'node:path';
import type { IModlistSource, InstallMeta, ModlistEntry, PluginEntry } from '../model';
import type { Reporter } from '../deployer';
import {
  insertModAtWinningEnd,
  deleteSeparatorInText,
  insertSeparatorAtIndexInText,
  moveModInText,
  moveModToSeparatorEndInText,
  moveSeparatorBlockInText,
  parseModlist,
  removeModFromText,
  renameSeparatorInText,
  setEnabledInText,
  unlistedModNames,
  deadModEntryNames,
} from './modlistText';
import { appendPluginInText, movePluginsInText, parsePlugins, setPluginEnabledInText } from './pluginsText';
import { parseMetaIni, writeMetaIni } from './metaIni';
import { setUninstalledInText } from './downloads';
import { readGameName, readSelectedProfile, setSelectedProfileInText } from './modOrganizerIni';
import { nexusSlugForGame } from './nexusSlug';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** MO2 instance adapter. `instanceRoot` is the folder containing
 *  ModOrganizer.ini, mods/ and profiles/ — i.e. the open VS Code workspace.
 *  Reads/writes the active profile; all writes are byte-faithful. */
export class Mo2ModlistSource implements IModlistSource {
  private modlistMutex: Promise<void> = Promise.resolve();

  private pluginsMutex: Promise<void> = Promise.resolve();

  private readonly log: (msg: string) => void;

  constructor(
    private readonly instanceRoot: string,
    log?: (msg: string) => void,
    private readonly reporter?: Reporter,
    private readonly rmFn: typeof rm = rm,
  ) {
    this.log = log ?? (() => {});
  }

  private get iniPath(): string {
    return join(this.instanceRoot, 'ModOrganizer.ini');
  }

  private async modlistPath(): Promise<string> {
    const profile = await this.getActiveProfile();
    return join(this.instanceRoot, 'profiles', profile, 'modlist.txt');
  }

  private modifyModlist(fn: (text: string) => string): Promise<void> {
    const task = this.modlistMutex.then(async () => {
      const path = await this.modlistPath();
      await writeFile(path, fn(await readFile(path, 'utf8')));
    });
    // Chain tail must never stay rejected, or every later call would hang forever
    // waiting on a dead link — only the caller's own `task` should see the error.
    this.modlistMutex = task.catch(() => undefined);
    return task;
  }

  async readModlist(): Promise<ModlistEntry[]> {
    const path = await this.modlistPath();
    const entries = parseModlist(await readFile(path, 'utf8'));
    return Promise.all(
      entries.map(async (entry) => {
        if (entry.kind !== 'mod') return entry;
        return { ...entry, ...(await this.readMeta(entry.name)) };
      }),
    );
  }

  private async readMeta(modName: string) {
    try {
      return parseMetaIni(await readFile(join(this.instanceRoot, 'mods', modName, 'meta.ini'), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; // no meta.ini → fields undefined
      throw err; // a present-but-unreadable meta.ini is a real failure, not "no metadata"
    }
  }

  async setEnabled(modName: string, enabled: boolean): Promise<void> {
    await this.modifyModlist((t) => setEnabledInText(t, modName, enabled));
  }

  async reorder(modName: string, toIndex: number): Promise<void> {
    await this.modifyModlist((t) => moveModInText(t, modName, toIndex));
  }

  async insertSeparator(name: string, afterEntryName: string): Promise<void> {
    await this.modifyModlist((text) => {
      const entries = parseModlist(text);
      const entryIdx = entries.findIndex((e) => e.name === afterEntryName);
      if (entryIdx === -1) throw new Error(`Entry not found in modlist: ${afterEntryName}`);
      let afterIndex = entryIdx;
      if (entries[entryIdx].kind === 'separator') {
        for (let i = entryIdx + 1; i < entries.length; i++) {
          if (entries[i].kind === 'separator') break;
          afterIndex = i;
        }
      }
      return insertSeparatorAtIndexInText(text, name, afterIndex);
    });
  }

  async renameSeparator(oldName: string, newName: string): Promise<void> {
    await this.modifyModlist((t) => renameSeparatorInText(t, oldName, newName));
  }

  async deleteSeparator(name: string): Promise<void> {
    await this.modifyModlist((t) => deleteSeparatorInText(t, name));
  }

  async moveModToSeparator(modName: string, separatorName: string | null): Promise<void> {
    await this.modifyModlist((t) => moveModToSeparatorEndInText(t, modName, separatorName));
  }

  async removeMod(modName: string): Promise<void> {
    // Read meta.ini's installationFile before anything else is touched: once
    // the folder is deleted below, the link to the source download is gone.
    await this.writebackUninstalledOnDownload(modName);
    // De-list before deleting the folder, not after: if the folder-delete step
    // fails, the worst case is an orphaned folder (MO2 surfaces it as an
    // unmanaged mod — recoverable). The reverse order risks a dangling modlist
    // entry pointing at a folder that no longer exists.
    await this.modifyModlist((t) => removeModFromText(t, modName));
    const modDir = join(this.instanceRoot, 'mods', modName);
    try {
      await this.rmFn(modDir, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[Mo2ModlistSource] removeMod: could not delete folder for "${modName}": ${message}`);
      this.reporter?.report(
        'warning',
        `"${modName}" was removed from the mod list, but its folder could not be deleted and is now orphaned: ${modDir}`,
        message,
      );
    }
  }

  /** The symmetric half of Install's `installed=true` writeback — set
   *  `uninstalled=true` on the source download's `.meta` (never clearing
   *  `installed`; `parseDownloadMeta` resolves the precedence). Uninstall must
   *  never fail because of this bookkeeping: an absent/unreadable meta.ini, a
   *  blank or non-matching installationFile, and an absent download are all
   *  normal states and skipped silently; a genuine write failure is logged
   *  (ADR-0026 background/recoverable — no toast) and otherwise swallowed. */
  private async writebackUninstalledOnDownload(modName: string): Promise<void> {
    let archiveFilename: string | undefined;
    try {
      const metaIniText = await readFile(join(this.instanceRoot, 'mods', modName, 'meta.ini'), 'utf8');
      archiveFilename = parseMetaIni(metaIniText).archiveFilename;
    } catch {
      // no meta.ini, or unreadable — nothing to look up. archiveFilename stays
      // undefined, and the guard right below already returns for that case.
    }
    if (!archiveFilename) return;
    const downloadPath = join(this.instanceRoot, 'downloads', archiveFilename);
    if (!(await exists(downloadPath))) return; // installationFile names a file not in downloads/ — normal
    const metaPath = `${downloadPath}.meta`;
    try {
      let metaText: string;
      try {
        metaText = await readFile(metaPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') metaText = '';
        else throw err;
      }
      await writeFile(metaPath, setUninstalledInText(metaText));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[Mo2ModlistSource] removeMod: could not mark download "${archiveFilename}" uninstalled: ${message}`);
    }
  }

  async installMod(name: string, sourceDir: string, meta: InstallMeta): Promise<void> {
    const modDir = join(this.instanceRoot, 'mods', name);
    if (await exists(modDir)) throw new Error(`A mod named "${name}" already exists.`);
    await cp(sourceDir, modDir, { recursive: true });
    const gameName = readGameName(await readFile(this.iniPath, 'utf8'));
    await writeFile(join(modDir, 'meta.ini'), writeMetaIni({ gameName, ...meta }));
    await this.modifyModlist((t) => insertModAtWinningEnd(t, name));
  }

  /** Add a disabled winning-end modlist.txt entry for every `mods/` folder
   *  that isn't already registered (excluding `overwrite/` and separator
   *  marker folders) — covers a mod folder dropped into `mods/` outside
   *  Modbench (Explorer drag-in, hand-extracted archive). Returns the names
   *  it registered, so callers can skip a no-op refresh. Idempotent: a name
   *  already registered by an earlier call is excluded on the next one. */
  async registerUnlistedMods(): Promise<string[]> {
    let dirents;
    try {
      dirents = await readdir(join(this.instanceRoot, 'mods'), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // no mods/ folder yet
      throw err;
    }
    const dirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    const entries = parseModlist(await readFile(await this.modlistPath(), 'utf8'));
    const names = unlistedModNames(dirNames, entries);
    // insertModAtWinningEnd always lands its new line above whatever's
    // currently first, so inserting in reverse-sorted order leaves the batch
    // in ascending sorted order top-to-bottom on disk.
    for (const name of [...names].reverse()) {
      await this.modifyModlist((t) => insertModAtWinningEnd(t, name));
    }
    return names;
  }

  /** The inverse of `registerUnlistedMods` (#93): remove every modlist.txt `mod` entry
   *  whose `mods/<name>/` folder no longer exists — deleted outside Modbench while it
   *  wasn't running or watching. Disk is the source of truth, so no confirmation: the user
   *  is the one who deleted the folder. Returns the names it pruned. A missing `mods/`
   *  directory prunes nothing (same ENOENT posture as registerUnlistedMods — a malformed
   *  workspace must not read as a mass delete); any other readdir failure propagates. */
  async pruneDeadEntries(): Promise<string[]> {
    let dirents;
    try {
      dirents = await readdir(join(this.instanceRoot, 'mods'), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const dirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    const entries = parseModlist(await readFile(await this.modlistPath(), 'utf8'));
    const names = deadModEntryNames(dirNames, entries);
    for (const name of names) {
      await this.modifyModlist((t) => removeModFromText(t, name));
    }
    return names;
  }

  async reorderSeparatorBlock(separatorName: string, toIndex: number): Promise<void> {
    await this.modifyModlist((t) => moveSeparatorBlockInText(t, separatorName, toIndex));
  }

  async getNexusSlug(): Promise<string> {
    return nexusSlugForGame(readGameName(await readFile(this.iniPath, 'utf8')));
  }

  async listProfiles(): Promise<string[]> {
    const dirents = await readdir(join(this.instanceRoot, 'profiles'), { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  }

  async listSeparators(): Promise<string[]> {
    const entries = await this.readModlist();
    return entries.filter((e) => e.kind === 'separator').map((e) => e.name);
  }

  async getActiveProfile(): Promise<string> {
    return readSelectedProfile(await readFile(this.iniPath, 'utf8'));
  }

  async setActiveProfile(name: string): Promise<void> {
    await writeFile(this.iniPath, setSelectedProfileInText(await readFile(this.iniPath, 'utf8'), name));
  }

  private async pluginsPath(): Promise<string> {
    const profile = await this.getActiveProfile();
    return join(this.instanceRoot, 'profiles', profile, 'plugins.txt');
  }

  private modifyPlugins(fn: (text: string) => string): Promise<void> {
    const task = this.pluginsMutex.then(async () => {
      const path = await this.pluginsPath();
      await writeFile(path, fn(await readFile(path, 'utf8')));
    });
    // Chain tail must never stay rejected, or every later call would hang forever
    // waiting on a dead link — only the caller's own `task` should see the error.
    this.pluginsMutex = task.catch(() => undefined);
    return task;
  }

  async readPluginOrder(): Promise<string[]> {
    return (await this.readPluginEntries()).map((e) => e.name);
  }

  async readEnabledPlugins(): Promise<string[]> {
    return (await this.readPluginEntries()).filter((e) => e.enabled).map((e) => e.name);
  }

  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.modifyPlugins((t) => setPluginEnabledInText(t, pluginName, enabled));
  }

  async reorderPlugins(pluginNames: string[], toIndex: number): Promise<void> {
    await this.modifyPlugins((t) => movePluginsInText(t, pluginNames, toIndex));
  }

  async appendPlugin(pluginName: string): Promise<void> {
    await this.modifyPlugins((t) => appendPluginInText(t, pluginName));
  }

  private async readPluginEntries(): Promise<PluginEntry[]> {
    return parsePlugins(await readFile(await this.pluginsPath(), 'utf8'));
  }
}
