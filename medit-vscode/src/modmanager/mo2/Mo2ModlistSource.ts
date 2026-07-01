import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource, ModlistEntry } from '../model';
import {
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
import { parseMetaIni } from './metaIni';
import { readGameName, readSelectedProfile, setSelectedProfileInText } from './modOrganizerIni';

const NEXUS_SLUGS: Record<string, string> = {
  'Fallout 4': 'fallout4',
  'Fallout 4 VR': 'fallout4',
  'Fallout 3': 'fallout3',
  'Fallout New Vegas': 'newvegas',
  'Skyrim': 'skyrim',
  'Skyrim Special Edition': 'skyrimspecialedition',
  'Skyrim VR': 'skyrimspecialedition',
  'Enderal': 'enderal',
  'Oblivion': 'oblivion',
  'Morrowind': 'morrowind',
};

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

  private async modifyModlist(fn: (text: string) => string): Promise<void> {
    const path = await this.modlistPath();
    await writeFile(path, fn(await readFile(path, 'utf8')));
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
    await this.modifyModlist((t) => removeModFromText(t, modName));
    await rm(join(this.instanceRoot, 'mods', modName), { recursive: true, force: true });
  }

  async reorderSeparatorBlock(separatorName: string, toIndex: number): Promise<void> {
    await this.modifyModlist((t) => moveSeparatorBlockInText(t, separatorName, toIndex));
  }

  async getNexusSlug(): Promise<string> {
    const gameName = readGameName(await readFile(this.iniPath, 'utf8'));
    return NEXUS_SLUGS[gameName] ?? gameName.toLowerCase().replace(/\s+/g, '');
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
