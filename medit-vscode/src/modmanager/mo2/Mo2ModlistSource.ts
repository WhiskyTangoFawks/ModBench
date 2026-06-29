import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource, ModlistEntry } from '../model';
import { parseModlist, setEnabledInText, moveModInText } from './modlistText';
import { parseMetaIni } from './metaIni';
import { readSelectedProfile, setSelectedProfileInText } from './modOrganizerIni';

/** MO2 instance adapter. `instanceRoot` is the folder containing
 *  ModOrganizer.ini, mods/ and profiles/ — i.e. the open VS Code workspace.
 *  Reads/writes the active profile; all writes are byte-faithful. */
export class Mo2ModlistSource implements IModlistSource {
  constructor(private readonly instanceRoot: string) {}

  private get iniPath(): string {
    return join(this.instanceRoot, 'ModOrganizer.ini');
  }

  private async modlistPath(): Promise<string> {
    const profile = await this.getActiveProfile();
    return join(this.instanceRoot, 'profiles', profile, 'modlist.txt');
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
    const path = await this.modlistPath();
    await writeFile(path, setEnabledInText(await readFile(path, 'utf8'), modName, enabled));
  }

  async reorder(modName: string, toIndex: number): Promise<void> {
    const path = await this.modlistPath();
    await writeFile(path, moveModInText(await readFile(path, 'utf8'), modName, toIndex));
  }

  async listProfiles(): Promise<string[]> {
    const dirents = await readdir(join(this.instanceRoot, 'profiles'), { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  }

  async getActiveProfile(): Promise<string> {
    return readSelectedProfile(await readFile(this.iniPath, 'utf8'));
  }

  async setActiveProfile(name: string): Promise<void> {
    await writeFile(this.iniPath, setSelectedProfileInText(await readFile(this.iniPath, 'utf8'), name));
  }

  async readPluginOrder(): Promise<string[]> {
    const profile = await this.getActiveProfile();
    const text = await readFile(join(this.instanceRoot, 'profiles', profile, 'plugins.txt'), 'utf8');
    return text
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim()) // also strips a leading UTF-8 BOM (U+FEFF) so the comment header still matches
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((l) => (l.startsWith('*') ? l.slice(1) : l));
  }
}
