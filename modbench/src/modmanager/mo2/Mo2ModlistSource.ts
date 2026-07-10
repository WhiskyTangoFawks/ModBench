import { readFile, writeFile, readdir, rm, cp, access } from 'node:fs/promises'; // access used by exists()
import { join } from 'node:path';
import type { IModlistSource, InstallMeta, ModlistEntry } from '../model';
import type { Reporter } from '../deployer';
import {
  appendModToText,
  deleteSeparatorInText,
  insertSeparatorAtIndexInText,
  moveModInText,
  moveModToSeparatorEndInText,
  moveSeparatorBlockInText,
  parseModlist,
  removeModFromText,
  renameSeparatorInText,
  setEnabledInText,
} from './modlistText';
import { parseMetaIni, writeMetaIni } from './metaIni';
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

  async installMod(name: string, sourceDir: string, meta: InstallMeta): Promise<void> {
    const modDir = join(this.instanceRoot, 'mods', name);
    if (await exists(modDir)) throw new Error(`A mod named "${name}" already exists.`);
    await cp(sourceDir, modDir, { recursive: true });
    const gameName = readGameName(await readFile(this.iniPath, 'utf8'));
    await writeFile(join(modDir, 'meta.ini'), writeMetaIni({ gameName, ...meta }));
    await this.modifyModlist((t) => appendModToText(t, name));
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

  async readPluginOrder(): Promise<string[]> {
    return (await this.readPluginLines()).map((l) => (l.startsWith('*') ? l.slice(1) : l));
  }

  async readEnabledPlugins(): Promise<string[]> {
    return (await this.readPluginLines())
      .filter((l) => l.startsWith('*'))
      .map((l) => l.slice(1));
  }

  /** Non-comment, non-blank plugins.txt lines in order (leading `*` retained). */
  private async readPluginLines(): Promise<string[]> {
    const profile = await this.getActiveProfile();
    const text = await readFile(join(this.instanceRoot, 'profiles', profile, 'plugins.txt'), 'utf8');
    return text
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim()) // also strips a leading UTF-8 BOM (U+FEFF) so the comment header still matches
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  }
}
