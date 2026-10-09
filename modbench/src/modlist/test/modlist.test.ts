import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import {
  mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import {
  modSyncOver,
  modlistCommands,
} from '../modlist';
import { adapterOver, readModlistEntries } from '../../test/mo2/adapterOver';
import type { InstanceAdapter, ModFolder, ModlistEntry } from '../../instanceAdapter/instanceAdapter';

const fixture = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance');

const FIXTURE_MOD_FOLDERS = [
  'Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k', 'Harder VATS',
  'SKK Fast Start new game (Fallout 4)', 'Unassigned (Modlist Development)_separator',
  'Unofficial Fallout 4 Patch',
];
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

function adapterWith(root: string, over: (adapter: InstanceAdapter) => Partial<InstanceAdapter>) {
  const adapter = adapterOver(root);
  return { ...adapter, ...over(adapter) };
}

const refusingWrite = (message: string) => ({ changeModOrder: () => Promise.reject(new Error(message)) });

function watchedAdapter(root: string, calls: string[] = []) {
  const adapter = adapterOver(root);
  const watched = {
    ...adapter,
    changeModOrder: (...args: Parameters<typeof adapter.changeModOrder>) => {
      calls.push('changeModOrder');
      return adapter.changeModOrder(...args);
    },
    markDownloadedFile: (...args: Parameters<typeof adapter.markDownloadedFile>) => {
      calls.push('markDownloadedFile');
      return adapter.markDownloadedFile(...args);
    },
  };
  return { adapter: watched, calls };
}

async function foldersAsAValueListsThem(root: string, names: readonly string[]): Promise<ModFolder[]> {
  const listed = (await adapterOver(root).modFolders())?.all ?? [];
  return names.map((name) => {
    const path = join(root, 'mods', name);
    return listed.find((folder) => folder.path === path) ?? { kind: 'mod', name, path };
  });
}

function assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(result: { applied: boolean; refusal?: string }, expectedSubstring?: string): void {
  if (result.applied) throw new Error('expected a refusal, got applied:true');
  expect(typeof result.refusal).toBe('string');
  if (expectedSubstring !== undefined) expect(result.refusal).toContain(expectedSubstring);
}

describe('modlist.txt commands — bytes written, or a refusal returned', () => {
  let dir: string;
  const modlistPath = () => join(dir, 'profiles', 'Default', 'modlist.txt');
  const readModlist = () => readModlistEntries(dir);
  const mtime = async () => (await stat(modlistPath())).mtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-commands-'));
    cpSync(fixture, dir, { recursive: true });
    await utimes(modlistPath(), LONG_AGO, LONG_AGO);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setModsEnabled flips only the mods not already in the chosen state, in one write', async () => {
    const { adapter, calls } = watchedAdapter(dir);
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapter).setModsEnabled('Default', ['Harder VATS', 'ENBoost - 12k'], true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Harder VATS', 'ENBoost - 12k'], refused: [] } });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
    expect(calls).toEqual(['changeModOrder']);
  });

  it('setModsEnabled to a selection already in the chosen state writes nothing', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).setModsEnabled('Default', ['ENBoost - 12k', 'SKK Fast Start new game (Fallout 4)'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['ENBoost - 12k', 'SKK Fast Start new game (Fallout 4)'], refused: [] },
    });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('setModsEnabled refuses a gone mod by name while the rest land, in one write', async () => {
    const { adapter, calls } = watchedAdapter(dir);
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapter).setModsEnabled('Default', ['Harder VATS', 'No Such Mod'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: ['Harder VATS'],
        refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }],
      },
    });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
    expect(calls).toEqual(['changeModOrder']);
  });

  it('refuses the whole selection once, before any write, when modlist.txt cannot be read, rather than answering applied with one reason repeated per mod', async () => {
    await rm(modlistPath());

    const outcome = await modlistCommands(adapterOver(dir)).setModsEnabled('Default', ['Harder VATS', 'ENBoost - 12k'], true);

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'ENOENT');
    await expect(stat(modlistPath())).rejects.toThrow();
  });

  it('insertSeparator writes a new enabled separator line after the named entry', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    const idx = entries.findIndex((e) => e.name === 'ENBoost - 12k');
    expect(entries[idx + 1]).toEqual({ kind: 'separator', name: 'New Section', enabled: true });
  });

  it('insertSeparator on a mod inside a separator splits it: the mods on the anchor\'s winning side join the new one', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'mod', name: '[NODELETE] Radfall' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual([
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'New Section',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('insertSeparator on an ungrouped mod lands directly on its losing side, same as a mod inside a separator', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'mod', name: 'Harder VATS' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual([
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'New Section',
      'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('insertSeparator on a separator lands on the winning side of its last mod, taking none', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual([
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      'New Section',
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('insertSeparator on the winning-most separator lands before every mod', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'separator', name: 'Unassigned (Modlist Development)' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual([
      'New Section',
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('insertSeparator on a separator with no mods of its own adds an equally empty one before it', async () => {
    await writeFile(modlistPath(), '+FirstGroup_separator\r\n+SecondGroup_separator\r\n+SKK Fast Start new game (Fallout 4)\r\n', 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'separator', name: 'SecondGroup' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual(['FirstGroup', 'New Section', 'SecondGroup', 'SKK Fast Start new game (Fallout 4)']);
  });

  it('insertSeparator makes the separator\'s folder beside its new line', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await stat(join(dir, 'mods', 'New Section_separator'))).isDirectory()).toBe(true);
  });

  it('insertSeparator whose write the adapter refuses refuses with the reason and leaves modlist.txt as it was', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterWith(dir, () => refusingWrite('permission denied'))).insertSeparator('Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'permission denied');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('renameSeparator to its own name, as MO2 would name its folder, writes nothing', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Unassigned (Modlist Development)', ' Unassigned (Modlist Development). ');

    expect(outcome).toEqual({ applied: true, wrote: false });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('insertSeparator refuses a name another separator has, writing neither line nor folder', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'Radfall - All-In-One Survival Overhaul', { kind: 'mod', name: 'ENBoost - 12k' });

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'Separator already in modlist: Radfall - All-In-One Survival Overhaul');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    await expect(stat(join(dir, 'mods', 'Radfall - All-In-One Survival Overhaul_separator'))).rejects.toThrow();
  });

  it('insertSeparator takes a name a mod has: a mod is no clash', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'Harder VATS', { kind: 'mod', name: 'ENBoost - 12k' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await readModlist()).filter((e) => e.name === 'Harder VATS').map((e) => e.kind)).toEqual(['separator', 'mod']);
  });

  it('insertSeparator anchors on the entry of the kind it is handed, when a mod and a separator share its name', async () => {
    await writeFile(modlistPath(), '+Armor\r\n+Gear_separator\r\n+Gear\r\n', 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'mod', name: 'Gear' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await readFile(modlistPath(), 'utf8')).toBe('+Armor\r\n+Gear_separator\r\n+Gear\r\n+New Section_separator\r\n');
  });

  describe('a separator name filtered as MO2 filters a folder name (MOBase::fixDirectoryName), so no name reaches a folder outside mods/<name>_separator/', () => {
    it('insertSeparator drops path separators, so ../x and A/B stay folders inside mods/', async () => {
      await modlistCommands(adapterOver(dir)).insertSeparator('Default', '../Escape', { kind: 'mod', name: 'ENBoost - 12k' });
      await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'A/B', { kind: 'mod', name: 'ENBoost - 12k' });

      const separators = (await readModlist()).filter((e) => e.kind === 'separator').map((e) => e.name);
      expect(separators).toContain('..Escape');
      expect(separators).toContain('AB');
      expect((await stat(join(dir, 'mods', '..Escape_separator'))).isDirectory()).toBe(true);
      expect((await stat(join(dir, 'mods', 'AB_separator'))).isDirectory()).toBe(true);
      expect(await readdir(dir)).not.toContain('Escape_separator');
      await expect(stat(join(dir, 'mods', 'A'))).rejects.toThrow();
    });

    it('insertSeparator refuses a name that leaves no folder name, writing neither line nor folder', async () => {
      const before = await readFile(modlistPath(), 'utf8');
      const foldersBefore = await readdir(join(dir, 'mods'));

      const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'CON', { kind: 'mod', name: 'ENBoost - 12k' });

      expect(outcome).toEqual({ applied: false, refusal: 'Not a valid separator name: "CON"' });
      expect(await readFile(modlistPath(), 'utf8')).toBe(before);
      expect(await readdir(join(dir, 'mods'))).toEqual(foldersBefore);
    });

    it('renameSeparator drops path separators from the new name, so its folder stays inside mods/', async () => {
      await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Unassigned (Modlist Development)', '../Escape');

      expect((await readModlist()).some((e) => e.kind === 'separator' && e.name === '..Escape')).toBe(true);
      expect((await stat(join(dir, 'mods', '..Escape_separator'))).isDirectory()).toBe(true);
      expect(await readdir(dir)).not.toContain('Escape_separator');
    });

    it('a separator line another tool wrote, whose name escapes mods/ to a folder no filtered name could reach, is renamed and deleted on its line alone', async () => {
      await writeFile(modlistPath(), '+../Escape_separator\r\n+Harder VATS\r\n', 'utf8');
      const outside = join(dir, 'Escape_separator');
      await mkdir(outside);
      const trashed: string[] = [];

      await modlistCommands(adapterOver(dir)).renameSeparator('Default', '../Escape', 'Inside');
      await modlistCommands(adapterOver(dir)).deleteSeparators('Default', ['Inside'], (path) => {
        trashed.push(path);
        return Promise.resolve();
      });
      await writeFile(modlistPath(), '+../Escape_separator\r\n', 'utf8');
      await modlistCommands(adapterOver(dir)).deleteSeparators('Default', ['../Escape'], (path) => {
        trashed.push(path);
        return Promise.resolve();
      });

      expect(trashed).toEqual([]);
      expect((await stat(outside)).isDirectory()).toBe(true);
      await expect(stat(join(dir, 'mods', 'Inside_separator'))).rejects.toThrow();
      expect(await readModlist()).toEqual([]);
    });
  });

  it('insertSeparator refuses when the anchor entry is absent', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await modlistCommands(adapterOver(dir)).insertSeparator('Default', 'New Section', { kind: 'mod', name: 'No Such Entry' });
    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('renameSeparator rewrites the separator line in place', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Unassigned (Modlist Development)', 'Renamed');
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    expect(entries.some((e) => e.name === 'Renamed' && e.kind === 'separator')).toBe(true);
    expect(entries.some((e) => e.name === 'Unassigned (Modlist Development)')).toBe(false);
  });

  it('renameSeparator renames the separator\'s folder with its line', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Unassigned (Modlist Development)', 'Renamed');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await stat(join(dir, 'mods', 'Renamed_separator'))).isDirectory()).toBe(true);
    await expect(stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).rejects.toThrow();
  });

  it('renameSeparator of a separator with no folder renames the line alone and makes no folder', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Radfall - All-In-One Survival Overhaul', 'Renamed');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await readModlist()).some((e) => e.kind === 'separator' && e.name === 'Renamed')).toBe(true);
    await expect(stat(join(dir, 'mods', 'Renamed_separator'))).rejects.toThrow();
  });

  it('renameSeparator refuses a name another separator has, writing neither line nor folder', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Unassigned (Modlist Development)', 'Radfall - All-In-One Survival Overhaul');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'Separator already in modlist: Radfall - All-In-One Survival Overhaul');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect((await stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).isDirectory()).toBe(true);
    await expect(stat(join(dir, 'mods', 'Radfall - All-In-One Survival Overhaul_separator'))).rejects.toThrow();
  });

  it('renameSeparator takes a name a mod has: a mod is no clash', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'Unassigned (Modlist Development)', 'Harder VATS');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await stat(join(dir, 'mods', 'Harder VATS_separator'))).isDirectory()).toBe(true);
  });

  it('renameSeparator whose write the adapter refuses refuses with the reason and leaves modlist.txt as it was', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterWith(dir, () => refusingWrite('folder in use'))).renameSeparator('Default', 'Unassigned (Modlist Development)', 'Renamed');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'folder in use');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect((await stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).isDirectory()).toBe(true);
  });

  it('renameSeparator refuses an unknown separator', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await modlistCommands(adapterOver(dir)).renameSeparator('Default', 'No Such Separator', 'Renamed');
    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  describe('deleteSeparators', () => {
    const UNASSIGNED = 'Unassigned (Modlist Development)';
    const RADFALL = 'Radfall - All-In-One Survival Overhaul';
    const unassignedFolder = () => join(dir, 'mods', `${UNASSIGNED}_separator`);
    const trashed: string[] = [];
    const trash = async (path: string) => {
      trashed.push(path);
      await rm(path, { recursive: true });
    };
    beforeEach(() => { trashed.length = 0; });

    const order = async () => (await readModlist()).map((e) => `${e.kind}:${e.name}`);

    it('removes the line and trashes the folder, and the mods it held join the separator above', async () => {
      const outcome = await modlistCommands(adapterOver(dir)).deleteSeparators('Default', [UNASSIGNED], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: UNASSIGNED }], refused: [] } });
      expect(await order()).toEqual([
        'mod:SKK Fast Start new game (Fallout 4)', 'mod:[NODELETE] Radfall', 'mod:Unofficial Fallout 4 Patch',
        `separator:${RADFALL}`, 'mod:ENBoost - 12k', 'mod:Harder VATS', 'mod:Cracked and Smudged Pip-Boy Screen',
      ]);
      expect(trashed).toEqual([unassignedFolder()]);
    });

    it('the mods of the first separator become ungrouped', async () => {
      const outcome = await modlistCommands(adapterOver(dir)).deleteSeparators('Default', [RADFALL], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: RADFALL }], refused: [] } });
      expect(await order()).toEqual([
        'mod:SKK Fast Start new game (Fallout 4)', `separator:${UNASSIGNED}`, 'mod:[NODELETE] Radfall',
        'mod:Unofficial Fallout 4 Patch', 'mod:ENBoost - 12k', 'mod:Harder VATS', 'mod:Cracked and Smudged Pip-Boy Screen',
      ]);
    });

    it('removes every selected line in one write', async () => {
      const { adapter, calls } = watchedAdapter(dir);

      const outcome = await modlistCommands(adapter).deleteSeparators('Default', [UNASSIGNED, RADFALL], trash);

      expect(outcome).toEqual({
        applied: true, outcome: { landed: [{ name: UNASSIGNED }, { name: RADFALL }], refused: [] },
      });
      expect((await readModlist()).every((e) => e.kind === 'mod')).toBe(true);
      expect(calls).toEqual(['changeModOrder']);
    });

    it('refuses a gone separator by name while the others land, in one write, trashing nothing for it, its folder left under mods/ as MO2 or another tool may leave it', async () => {
      const { adapter, calls } = watchedAdapter(dir);
      await mkdir(join(dir, 'mods', 'No Such Separator_separator'));

      const outcome = await modlistCommands(adapter).deleteSeparators('Default', ['No Such Separator', UNASSIGNED], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: UNASSIGNED }],
          refused: [{ item: { name: 'No Such Separator' }, reason: 'Separator not found in modlist: No Such Separator' }],
        },
      });
      expect(trashed).toEqual([unassignedFolder()]);
      expect(calls).toEqual(['changeModOrder']);
    });

    it('refuses the whole selection once and trashes nothing when modlist.txt cannot be read', async () => {
      await rm(modlistPath());

      const outcome = await modlistCommands(adapterOver(dir)).deleteSeparators('Default', [UNASSIGNED, RADFALL], trash);

      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'ENOENT');
      expect(trashed).toEqual([]);
    });

    it('a separator whose line cannot go after its folder was trashed still lands, carrying the part that failed, and one with no folder to trash is refused with the write\'s reason', async () => {
      const before = await readFile(modlistPath(), 'utf8');

      const outcome = await modlistCommands(adapterWith(dir, () => refusingWrite('disk full'))).deleteSeparators('Default', [UNASSIGNED, RADFALL], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: UNASSIGNED, lineRefusal: 'disk full' }],
          refused: [{ item: { name: RADFALL }, reason: 'disk full' }],
        },
      });
      expect(trashed).toEqual([unassignedFolder()]);
      expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    });

    it('the line a delete leaves after the trash, naming a folder that is gone, is dropped by the next mod sync, which drops a separator line', async () => {
      await modlistCommands(adapterWith(dir, () => refusingWrite('disk full'))).deleteSeparators('Default', [UNASSIGNED], trash);
      expect(await order()).toContain(`separator:${UNASSIGNED}`);

      const outcome = await modSyncOver(adapterOver(dir))({ profile: 'Default', modFolders: await foldersAsAValueListsThem(dir, await readdir(join(dir, 'mods'))) });

      expect(outcome.applied && outcome.dropped).toContain(`${UNASSIGNED} (separator)`);
      expect(await order()).not.toContain(`separator:${UNASSIGNED}`);
    });

    it('writes nothing for a separator whose folder the trash refuses, and refuses it with the reason, while the others land', async () => {
      const before = await readFile(modlistPath(), 'utf8');
      const refusingTrash = async (path: string) => {
        if (path === unassignedFolder()) throw new Error('trash unavailable');
        await trash(path);
      };

      const outcome = await modlistCommands(adapterOver(dir)).deleteSeparators('Default', [UNASSIGNED, RADFALL], refusingTrash);

      expect(outcome).toEqual({
        applied: true,
        outcome: { landed: [{ name: RADFALL }], refused: [{ item: { name: UNASSIGNED }, reason: 'trash unavailable' }] },
      });
      const withoutRadfallLine = before.split('\r\n').filter((line) => !line.includes(RADFALL)).join('\r\n');
      expect(await readFile(modlistPath(), 'utf8')).toBe(withoutRadfallLine);
      expect((await stat(unassignedFolder())).isDirectory()).toBe(true);
    });
  });

  it('moveMods at the losing end makes the mods the chosen separator\'s losing-most mods, keeping their order among themselves', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).moveMods('Default', ['Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k'],
      { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

    expect(outcome).toEqual({
      applied: true, outcome: { landed: ['Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k'], refused: [] },
    });
    expect((await readModlist()).map((e) => e.name)).toEqual([
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'ENBoost - 12k',
      'Cracked and Smudged Pip-Boy Screen',
      'Radfall - All-In-One Survival Overhaul',
      'Harder VATS',
    ]);
  });

  it('moveMods at the losing end of Ungrouped makes the mods the losing-most ungrouped mods, keeping their order', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).moveMods('Default', ['Unofficial Fallout 4 Patch', 'SKK Fast Start new game (Fallout 4)'], { kind: 'ungrouped' }, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Unofficial Fallout 4 Patch', 'SKK Fast Start new game (Fallout 4)'], refused: [] },
    });
    expect((await readModlist()).map((e) => e.name)).toEqual([
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
      'SKK Fast Start new game (Fallout 4)',
      'Unofficial Fallout 4 Patch',
    ]);
  });

  it('moveMods to where the mods already are writes nothing', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).moveMods('Default', ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'],
      { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

    expect(outcome).toEqual({
      applied: true, outcome: { landed: ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'], refused: [] },
    });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('moveMods refuses a gone mod by name while the others land, in one write', async () => {
    const { adapter, calls } = watchedAdapter(dir);

    const outcome = await modlistCommands(adapter).moveMods('Default', ['No Such Mod', 'Harder VATS'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    const names = (await readModlist()).map((e) => e.name);
    expect(names.slice(0, 3)).toEqual([
      'SKK Fast Start new game (Fallout 4)', 'Harder VATS', 'Unassigned (Modlist Development)',
    ]);
    expect(calls).toEqual(['changeModOrder']);
  });

  it('moveMods to a separator that has gone refuses the whole move, naming it', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).moveMods('Default', ['Harder VATS'], { kind: 'separator', name: 'Gone Separator' }, 'losing');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'Gone Separator');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('moveMods beside a mod that has gone refuses the whole move, naming it', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).moveMods('Default', ['Harder VATS'], { kind: 'mod', name: 'Gone Mod' }, 'losing');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'Gone Mod');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('moveMods refuses the whole selection once when modlist.txt cannot be read', async () => {
    await rm(modlistPath());

    const outcome = await modlistCommands(adapterOver(dir)).moveMods('Default', ['Harder VATS', 'ENBoost - 12k'], { kind: 'ungrouped' }, 'losing');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'ENOENT');
    await expect(stat(modlistPath())).rejects.toThrow();
  });

  it('moveSeparators on the losing side lands each separator with its mods directly on the losing side of the chosen one', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).moveSeparators('Default', ['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Unassigned (Modlist Development)'], refused: [] } });
    expect((await readModlist()).map((e) => e.name)).toEqual([
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('moveSeparators to where the separator already is writes nothing', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).moveSeparators('Default', ['Radfall - All-In-One Survival Overhaul'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Radfall - All-In-One Survival Overhaul'], refused: [] } });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('moveSeparators refuses a gone separator by name while the others land', async () => {
    const outcome = await modlistCommands(adapterOver(dir)).moveSeparators('Default', ['Gone Separator', 'Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: ['Unassigned (Modlist Development)'],
        refused: [{ item: 'Gone Separator', reason: 'Separator not found in modlist: Gone Separator' }],
      },
    });
    expect((await readModlist()).map((e) => e.name).slice(3, 5)).toEqual([
      'SKK Fast Start new game (Fallout 4)', 'Unassigned (Modlist Development)',
    ]);
  });

  it('moveSeparators to a separator that has gone refuses the whole move, naming it', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await modlistCommands(adapterOver(dir)).moveSeparators('Default', ['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Gone Separator' }, 'losing');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'Gone Separator');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  describe('uninstallMods', () => {
    const ARCHIVE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
    const metaPath = () => join(dir, 'downloads', `${ARCHIVE}.meta`);
    const trashed: string[] = [];
    const events: string[] = [];
    const trash = vi.fn(async (path: string) => {
      trashed.push(path);
      events.push('trash');
      await rm(path, { recursive: true });
    });
    beforeEach(() => { trashed.length = 0; events.length = 0; trash.mockClear(); });

    it('trashes the folder, then removes the line, then marks the download uninstalled, in that order', async () => {
      const { adapter } = watchedAdapter(dir, events);
      const outcome = await modlistCommands(adapter).uninstallMods('Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true, outcome: { landed: [{ name: 'Unofficial Fallout 4 Patch' }], refused: [] },
      });
      expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
      await expect(stat(join(dir, 'mods', 'Unofficial Fallout 4 Patch'))).rejects.toThrow();
      expect(await readFile(metaPath(), 'utf8')).toContain('uninstalled=true');
      expect(events).toEqual(['trash', 'changeModOrder', 'markDownloadedFile']);
    });

    it('trashes nothing outside mods/ for a mod whose line another tool wrote with a / in its name, and still drops its line, rather than joining the raw name onto mods/', async () => {
      const outside = join(dir, 'Escaped');
      await mkdir(outside);
      await writeFile(modlistPath(), `+../Escaped\r\n${await readFile(modlistPath(), 'utf8')}`);

      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default', [{ name: '../Escaped' }], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: '../Escaped' }], refused: [] } });
      expect(trashed).toEqual([]);
      expect((await stat(outside)).isDirectory()).toBe(true);
      expect((await readModlist()).some((e) => e.name === '../Escaped')).toBe(false);
    });

    it('removes every selected mod\'s line in one write', async () => {
      const { adapter, calls } = watchedAdapter(dir);

      const outcome = await modlistCommands(adapter).uninstallMods('Default', [{ name: 'Harder VATS' }, { name: 'ENBoost - 12k' }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: { landed: [{ name: 'Harder VATS' }, { name: 'ENBoost - 12k' }], refused: [] },
      });
      expect(calls).toEqual(['changeModOrder']);
    });

    it('refuses an unknown mod by name, trashing and marking nothing for it, while the rest land', async () => {
      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default', [{ name: 'No Such Mod' }, { name: 'Harder VATS' }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: 'Harder VATS' }],
          refused: [{ item: { name: 'No Such Mod' }, reason: 'Mod not found in modlist: No Such Mod' }],
        },
      });
      expect(trashed).toEqual([join(dir, 'mods', 'Harder VATS')]);
    });

    it('refuses the whole selection once and trashes nothing when modlist.txt cannot be read', async () => {
      await rm(modlistPath());

      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default', [{ name: 'Harder VATS' }], trash);

      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'ENOENT');
      expect(trashed).toEqual([]);
    });

    it('writes nothing for a mod whose folder the trash refuses, refusing it with the reason, while the others land and mark, leaving the refused mod\'s real downloaded file unmarked', async () => {
      const failingFolder = join(dir, 'mods', 'Harder VATS');
      const HARDER_VATS_ARCHIVE = 'Harder VATS-1-0.7z';
      const harderVatsMetaPath = join(dir, 'downloads', `${HARDER_VATS_ARCHIVE}.meta`);
      await writeFile(join(dir, 'downloads', HARDER_VATS_ARCHIVE), '');
      await writeFile(harderVatsMetaPath, '[General]\r\ninstalled=true\r\n');
      const refusingTrash = vi.fn(async (path: string) => {
        if (path === failingFolder) throw new Error('trash unavailable');
        await trash(path);
      });

      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default',
        [
          { name: 'Harder VATS', archiveFilename: HARDER_VATS_ARCHIVE },
          { name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE },
        ],
        refusingTrash,
      );

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: 'Unofficial Fallout 4 Patch' }],
          refused: [{ item: { name: 'Harder VATS' }, reason: 'trash unavailable' }],
        },
      });
      expect((await stat(failingFolder)).isDirectory()).toBe(true);
      expect((await readModlist()).some((e) => e.name === 'Harder VATS')).toBe(true);
      expect(await readFile(metaPath(), 'utf8')).toContain('uninstalled=true');
      expect(await readFile(harderVatsMetaPath, 'utf8')).not.toContain('uninstalled=true');
    });

    it('a mod whose line cannot go after its folder was trashed still lands, carrying the part that failed, and marks nothing for it', async () => {
      const outcome = await modlistCommands(adapterWith(dir, () => refusingWrite('disk full'))).uninstallMods('Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: 'Unofficial Fallout 4 Patch', lineRefusal: 'disk full' }],
          refused: [],
        },
      });
      expect(await readFile(metaPath(), 'utf8')).not.toContain('uninstalled=true');
    });

    it('carries the mark\'s refusal when the downloads folder cannot be resolved, rather than skipping the mark and leaving the download claiming a mod that is gone', async () => {
      const unresolved = new Error('download_directory "Z:\\gone" could not be resolved');
      const adapter = { ...adapterOver(dir), markDownloadedFile: () => Promise.reject(unresolved) };

      const outcome = await modlistCommands(adapter).uninstallMods('Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: { landed: [{ name: 'Unofficial Fallout 4 Patch', markRefusal: unresolved.message }], refused: [] },
      });
      expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
    });

    it('writes no sidecar for an archive that is absent from downloads/ (a mod can outlive its download, and MO2 writes no sidecar beside no archive)', async () => {
      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default', [{ name: 'Harder VATS', archiveFilename: 'Long Gone-1-0.7z' }], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
      await expect(stat(join(dir, 'downloads', 'Long Gone-1-0.7z.meta'))).rejects.toThrow();
    });

    it('drops a line another tool rewrote in another case after the folder went, rather than matching by the name the view listed', async () => {
      const recasingTrash = async (path: string) => {
        await trash(path);
        await writeFile(modlistPath(), (await readFile(modlistPath(), 'utf8')).replace('-Harder VATS', '-harder vats'));
      };

      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default', [{ name: 'Harder VATS' }], recasingTrash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
      expect((await readModlist()).some((e) => e.name.toLowerCase() === 'harder vats')).toBe(false);
    });

    it('lands whole when mod sync dropped the line after the folder went, not reporting a landed uninstall as part failed', async () => {
      const syncingTrash = async (path: string) => {
        await trash(path);
        await modSyncOver(adapterOver(dir))({ profile: 'Default', modFolders: [] });
      };

      const outcome = await modlistCommands(adapterOver(dir)).uninstallMods('Default', [{ name: 'Harder VATS' }], syncingTrash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
      expect((await readModlist()).some((e) => e.name === 'Harder VATS')).toBe(false);
    });
  });

  describe('renameMod', () => {
    const secondaryPath = () => join(dir, 'profiles', 'Secondary', 'modlist.txt');
    const rename = (to = 'Harder VATS 2') => modlistCommands(adapterOver(dir)).renameMod('Default', ['Secondary', 'Default'], 'Harder VATS', to);

    it('renames the folder and the line in every profile, keeping each state', async () => {
      const outcome = await rename();

      expect(outcome).toEqual({ applied: true, lineRefusals: [] });
      expect((await stat(join(dir, 'mods', 'Harder VATS 2'))).isDirectory()).toBe(true);
      expect(await readFile(modlistPath(), 'utf8')).toContain('-Harder VATS 2');
      expect(await readFile(secondaryPath(), 'utf8')).toContain('-Harder VATS 2');
    });

    it('names each profile whose line could not be written, the folder staying renamed', async () => {
      const secondaryBefore = await readFile(secondaryPath(), 'utf8');
      const refusingSecondary = adapterWith(dir, (adapter) => ({
        changeModOrder: (profile, decide) =>
          (profile === 'Secondary' ? Promise.reject(new Error('disk full')) : adapter.changeModOrder(profile, decide)),
      }));

      const outcome = await modlistCommands(refusingSecondary).renameMod('Default', ['Secondary', 'Default'], 'Harder VATS', 'Harder VATS 2');

      expect(outcome).toEqual({ applied: true, lineRefusals: [{ profile: 'Secondary', refusal: 'disk full' }] });
      expect((await stat(join(dir, 'mods', 'Harder VATS 2'))).isDirectory()).toBe(true);
      expect(await readFile(modlistPath(), 'utf8')).toContain('-Harder VATS 2');
      expect(await readFile(secondaryPath(), 'utf8')).toBe(secondaryBefore);
    });

    it('writes no line when the folder did not move', async () => {
      const before = await readFile(modlistPath(), 'utf8');

      const outcome = await rename('Unofficial Fallout 4 Patch');

      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'is in the way');
      expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    });
  });

  describe('createEmptyMod', () => {
    it('refuses a name a mod folder already has in another case (MO2 keys mods by name without case, and a Windows folder answers to either)', async () => {
      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(await modlistCommands(adapterOver(dir)).createEmptyMod('Default', 'harder vats'), 'already exists');
    });

    it('leaves a line mod sync already wrote in another case, rather than doubling it', async () => {
      await writeFile(modlistPath(), `-new mod\r\n${await readFile(modlistPath(), 'utf8')}`);

      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', 'New Mod');

      expect(outcome).toEqual({ applied: true, wrote: false });
      expect((await readModlist()).filter((e) => e.name.toLowerCase() === 'new mod')).toHaveLength(1);
    });

    it('refuses a name a separator\'s folder has, writing no line (MO2 knows a mod by its folder\'s name)', async () => {
      const before = await readFile(modlistPath(), 'utf8');
      const name = 'Unassigned (Modlist Development)_separator';

      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', name);

      expect(outcome).toEqual({
        applied: false,
        refusal: `A mod named "${name}" already exists — install its next release from the Downloads view instead.`,
      });
      expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    });

    it('refuses a name that would leave mods/, making no folder anywhere, rather than joining the name onto mods/ raw', async () => {
      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(await modlistCommands(adapterOver(dir)).createEmptyMod('Default', '../x'), 'Not a valid mod name');

      expect(await readdir(dir)).not.toContain('x');
      expect((await readModlist()).some((e) => e.name === '../x')).toBe(false);
    });

    it('creates an empty folder under mods/ and a disabled modlist line', async () => {
      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', 'My New Mod');
      expect(outcome).toEqual({ applied: true, wrote: true });
      expect((await stat(join(dir, 'mods', 'My New Mod'))).isDirectory()).toBe(true);
      expect(await readdir(join(dir, 'mods', 'My New Mod'))).toEqual([]);
      const entries = await readModlist();
      expect(entries.find((e) => e.name === 'My New Mod')).toEqual({ kind: 'mod', name: 'My New Mod', enabled: false });
    });

    it('lands the line at the winning end, disabled, exactly once, with the folder on disk', async () => {
      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', 'Winning End Mod');

      expect(outcome).toEqual({ applied: true, wrote: true });
      const entries = await readModlist();
      expect(entries[0]).toEqual({ kind: 'mod', name: 'Winning End Mod', enabled: false });
      expect(entries.filter((e) => e.name === 'Winning End Mod')).toHaveLength(1);
      expect((await stat(join(dir, 'mods', 'Winning End Mod'))).isDirectory()).toBe(true);
    });

    it('writes no line when the folder cannot be made, the folder going first', async () => {
      const { adapter, calls } = watchedAdapter(dir);
      const noFolder = { ...adapter, createModFolder: () => Promise.reject(new Error('permission denied')) };

      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(await modlistCommands(noFolder).createEmptyMod('Default', 'Folder Write Fails'), 'permission denied');

      expect(calls).toEqual([]);
    });

    it('refuses a name the value already lists as a folder, clobbering neither it nor the modlist', async () => {
      const beforeModlist = await readFile(modlistPath(), 'utf8');
      const before = await readdir(join(dir, 'mods', 'Harder VATS'));
      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', 'Harder VATS');
      assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(outcome, 'Harder VATS');
      expect(await readdir(join(dir, 'mods', 'Harder VATS'))).toEqual(before);
      expect(await readFile(modlistPath(), 'utf8')).toBe(beforeModlist);
    });

    it('refuses a lineless folder as a name that already exists, mod sync not having caught up yet', async () => {
      await mkdir(join(dir, 'mods', 'Lineless Folder'));

      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', 'Lineless Folder');

      expect(outcome.applied).toBe(false);
      expect(!outcome.applied && outcome.refusal).toMatch(/"Lineless Folder" already exists/);
    });

    it('writes no second line when mod sync already added it, winning the race against the command\'s own line write, and reports no failure', async () => {
      const name = 'Synced In First';
      await adapterOver(dir).changeModOrder('Default', () => [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name } }]);

      const outcome = await modlistCommands(adapterOver(dir)).createEmptyMod('Default', name);

      expect(outcome).toEqual({ applied: true, wrote: false });
      expect((await stat(join(dir, 'mods', name))).isDirectory()).toBe(true);
      expect((await readModlist()).filter((e) => e.name === name)).toHaveLength(1);
    });

    it('a failed line write leaves the folder in place and answers a partial, not a refusal, since the folder is on disk either way', async () => {
      const name = 'Line Write Fails';

      const outcome = await modlistCommands(adapterWith(dir, () => refusingWrite('disk full'))).createEmptyMod('Default', name);

      expect(outcome).toEqual({ applied: true, wrote: false, lineRefusal: 'disk full' });
      expect((await stat(join(dir, 'mods', name))).isDirectory()).toBe(true);
      expect((await readModlist()).some((e) => e.name === name)).toBe(false);
    });
  });
});

describe('syncMods — modlist.txt brought into line with the folders in mods/ it is handed', () => {
  let dir: string;
  const modlistPath = () => join(dir, 'profiles', 'Default', 'modlist.txt');
  const readModlist = () => readModlistEntries(dir);
  const mtime = async () => (await stat(modlistPath())).mtime;
  const sync = async (folders: readonly string[]) => modSyncOver(adapterOver(dir))({ profile: 'Default', modFolders: await foldersAsAValueListsThem(dir, folders) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-sync-'));
    cpSync(fixture, dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('adds a line for a folder with none and drops each line whose folder is gone, "[NODELETE] Radfall" and the Radfall separator having none, in one write rather than two splices', async () => {
    await mkdir(join(dir, 'mods', 'Hand Extracted Mod'));
    const { adapter, calls } = watchedAdapter(dir);

    const outcome = await modSyncOver(adapter)({ profile: 'Default', modFolders: await foldersAsAValueListsThem(dir, [...FIXTURE_MOD_FOLDERS, 'Hand Extracted Mod']) });

    expect(outcome).toEqual({
      applied: true, added: ['Hand Extracted Mod'],
      dropped: ['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)'],
    });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toContain('Hand Extracted Mod');
    expect(names).not.toContain('[NODELETE] Radfall');
    expect(calls).toEqual(['changeModOrder']);
  });

  it('writes the modlist.txt of the profile it is handed, and leaves the active profile\'s alone', async () => {
    await mkdir(join(dir, 'profiles', 'Other'));
    await writeFile(join(dir, 'profiles', 'Other', 'modlist.txt'), '+Gone Mod\r\n');
    const active = await readFile(modlistPath(), 'utf8');

    const outcome = await modSyncOver(adapterOver(dir))({ profile: 'Other', modFolders: await foldersAsAValueListsThem(dir, []) });

    expect(outcome).toEqual({ applied: true, added: [], dropped: ['Gone Mod'] });
    expect(await readFile(join(dir, 'profiles', 'Other', 'modlist.txt'), 'utf8')).toBe('');
    expect(await readFile(modlistPath(), 'utf8')).toBe(active);
  });

  it('writes nothing when every folder has a line and every mod line has a folder, rather than putting the bytes back to fire the watcher forever', async () => {
    await sync([...FIXTURE_MOD_FOLDERS, '[NODELETE] Radfall']);
    const settled = await readFile(modlistPath(), 'utf8');
    await utimes(modlistPath(), LONG_AGO, LONG_AGO);

    expect(await sync([...FIXTURE_MOD_FOLDERS, '[NODELETE] Radfall'])).toEqual({ applied: true, added: [], dropped: [] });
    expect(await readFile(modlistPath(), 'utf8')).toBe(settled);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('drops only the mod and separator lines whose folder is gone: every other line stays, the game\'s own * lines such as *DLC: Automatron included', async () => {
    const before = (await readFile(modlistPath(), 'utf8')).split('\r\n');

    await sync(FIXTURE_MOD_FOLDERS);

    const after = (await readFile(modlistPath(), 'utf8')).split('\r\n');
    expect(before.filter((line) => !after.includes(line))).toEqual([
      '+[NODELETE] Radfall', '-Radfall - All-In-One Survival Overhaul_separator',
    ]);
  });

  it('refuses, writing nothing, when mods/ is gone by the time the sync writes, rather than reading it as no folders and dropping every line', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    await rm(join(dir, 'mods'), { recursive: true });

    expect(await sync(FIXTURE_MOD_FOLDERS)).toEqual({ applied: false, refusal: 'there is no folder for mods' });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('refuses, writing nothing, when mods/ cannot be listed for another reason', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const folders = await foldersAsAValueListsThem(dir, FIXTURE_MOD_FOLDERS);
    await rm(join(dir, 'mods'), { recursive: true });
    await writeFile(join(dir, 'mods'), 'not a folder');

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(await modSyncOver(adapterOver(dir))({ profile: 'Default', modFolders: folders }), 'ENOTDIR');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('keeps the line of a mod whose folder is a link to a folder (MO2 lists a linked mod folder as a mod), rather than counting only real directories', async () => {
    const target = await mkdtemp(join(tmpdir(), 'linked-mod-'));
    try {
      await symlink(target, join(dir, 'mods', 'Linked Mod'), 'junction');
      await writeFile(modlistPath(), `+Linked Mod\r\n${await readFile(modlistPath(), 'utf8')}`);

      const outcome = await sync(FIXTURE_MOD_FOLDERS);

      expect(outcome.applied && outcome.dropped).not.toContain('Linked Mod');
      expect(await readModlist()).toContainEqual({ kind: 'mod', name: 'Linked Mod', enabled: true });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('skips a mod folder link whose target cannot be checked, and drops its line (MO2 has no mod by its name), rather than refusing the whole sync', async () => {
    await symlink(join(dir, 'mods', 'Loop'), join(dir, 'mods', 'Loop'));
    await writeFile(modlistPath(), `+Loop\r\n${await readFile(modlistPath(), 'utf8')}`);

    const outcome = await sync(FIXTURE_MOD_FOLDERS);

    expect(outcome.applied && outcome.dropped).toContain('Loop');
  });

  it('keeps a line whose folder differs only in case, when the handed list misses it (MO2 matches a line to its folder without case; a Linux disk does not)', async () => {
    await writeFile(modlistPath(), (await readFile(modlistPath(), 'utf8')).replace('-Harder VATS', '+harder vats'));
    const kept = (await readModlist())
      .filter((e) => e.name !== '[NODELETE] Radfall' && e.name !== 'Radfall - All-In-One Survival Overhaul');
    const lagging = FIXTURE_MOD_FOLDERS.filter((f) => f !== 'Harder VATS');

    const outcome = await sync(lagging);

    expect(outcome.applied && outcome.dropped).toEqual(['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)']);
    expect(await readModlist()).toEqual(kept);
    expect(kept).toContainEqual({ kind: 'mod', name: 'harder vats', enabled: true });
  });

  it('keeps a line whose folder the handed list misses but that is on disk at write time, the value lagging the disk', async () => {
    const lagging = FIXTURE_MOD_FOLDERS.filter((f) => f !== 'Harder VATS' && f !== 'Unassigned (Modlist Development)_separator');

    const outcome = await sync(lagging);

    expect(outcome.applied && outcome.dropped).toEqual(['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)']);
    const names = (await readModlist()).map((e) => `${e.kind}:${e.name}`);
    expect(names).toEqual(expect.arrayContaining(['mod:Harder VATS', 'separator:Unassigned (Modlist Development)']));
  });

  it('drops a separator line another tool wrote whose name MO2 never gives a folder, answering it dropped', async () => {
    await writeFile(modlistPath(), '-Weapons/Armor_separator\r\n+Harder VATS\r\n');
    const folders = await foldersAsAValueListsThem(dir, FIXTURE_MOD_FOLDERS);

    expect(await modSyncOver(adapterOver(dir))({ profile: 'Default', modFolders: folders })).toMatchObject({ applied: true, dropped: ['Weapons/Armor (separator)'] });
    expect(await readFile(modlistPath(), 'utf8')).not.toContain('Weapons/Armor');
  });

  it('drops a mod line whose name escapes mods/, answering it dropped (MO2 has no mod by a name with a /)', async () => {
    const outside = join(dir, 'Escaped');
    await mkdir(outside);
    await writeFile(modlistPath(), '+../Escaped\r\n+Harder VATS\r\n');
    const folders = await foldersAsAValueListsThem(dir, FIXTURE_MOD_FOLDERS);

    expect(await modSyncOver(adapterOver(dir))({ profile: 'Default', modFolders: folders })).toMatchObject({ applied: true, dropped: ['../Escaped'] });
  });

  it('matches a line to its folder without case, for a mod and a separator (MO2 keys both without case), dropping neither line and adding no second line for either', async () => {
    await writeFile(modlistPath(), '+harder vats\r\n-unassigned (modlist development)_separator\r\n');

    const outcome = await sync(FIXTURE_MOD_FOLDERS);

    expect(outcome.applied && outcome.dropped).toEqual([]);
    expect(outcome.applied && outcome.added).not.toEqual(expect.arrayContaining(['Harder VATS']));
    expect(outcome.applied && outcome.added).not.toEqual(expect.arrayContaining(['Unassigned (Modlist Development) (separator)']));
  });

  it('adds a disabled separator line at the winning end for a separator folder with none', async () => {
    await mkdir(join(dir, 'mods', 'Orphan_separator'));

    const outcome = await sync([...FIXTURE_MOD_FOLDERS, 'Orphan_separator']);

    expect(outcome.applied && outcome.added).toEqual(['Orphan (separator)']);
    expect((await readModlist())[0]).toEqual({ kind: 'separator', name: 'Orphan', enabled: false });
  });

  it('writes a batch of added lines ascending top-to-bottom, winning-most first', async () => {
    for (const name of ['Zeta Mod', 'Alpha Mod']) await mkdir(join(dir, 'mods', name));

    const outcome = await sync([...FIXTURE_MOD_FOLDERS, 'Zeta Mod', 'Alpha Mod']);

    expect(outcome).toMatchObject({ applied: true, added: ['Alpha Mod', 'Zeta Mod'] });
    expect((await readModlist()).slice(0, 2)).toEqual([
      { kind: 'mod', name: 'Alpha Mod', enabled: false },
      { kind: 'mod', name: 'Zeta Mod', enabled: false },
    ]);
  });

  it('adds no line for a folder the value lists but that is gone from disk at write time, as a renamed separator\'s old folder is', async () => {
    await rename(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'), join(dir, 'mods', 'Renamed_separator'));
    await writeFile(modlistPath(), (await readFile(modlistPath(), 'utf8')).replace(
      'Unassigned (Modlist Development)_separator', 'Renamed_separator'));

    const outcome = await sync([...FIXTURE_MOD_FOLDERS, 'Ghost Mod']);

    expect(outcome.applied && outcome.added).toEqual([]);
    const separators = (await readModlist()).filter((e) => e.kind === 'separator').map((e) => e.name);
    expect(separators).toContain('Renamed');
    expect(separators).not.toContain('Unassigned (Modlist Development)');
  });

  it('adds no line for a folder on disk that the value does not list yet, the mods to sync arriving as an argument', async () => {
    await mkdir(join(dir, 'mods', 'Landed Since'));

    const outcome = await sync(FIXTURE_MOD_FOLDERS);

    expect(outcome.applied && outcome.added).toEqual([]);
    expect((await readModlist()).map((e) => e.name)).not.toContain('Landed Since');
  });

  it('keeps a line whose folder is back on disk by the time the sync writes, deciding from the folders as the write finds them rather than the list it was handed', async () => {
    const lagging = FIXTURE_MOD_FOLDERS.filter((f) => f !== 'Harder VATS');
    const harderVats = join(dir, 'mods', 'Harder VATS');
    await rm(harderVats, { recursive: true });
    const folders = await foldersAsAValueListsThem(dir, lagging);
    const folderBackAtTheWrite = adapterWith(dir, (adapter) => ({
      changeModOrder: async (profile, decide) => {
        await mkdir(harderVats);
        return adapter.changeModOrder(profile, decide);
      },
    }));

    const outcome = await modSyncOver(folderBackAtTheWrite)({ profile: 'Default', modFolders: folders });

    expect(outcome.applied && outcome.dropped).not.toContain('Harder VATS');
    expect(await readModlist()).toContainEqual({ kind: 'mod', name: 'Harder VATS', enabled: false });
  });

  it('refuses when modlist.txt cannot be read, rather than throwing', async () => {
    await rm(modlistPath());

    assertRefusalNarrowedByHandSinceExpectMatchersAreTypedAny(await sync(FIXTURE_MOD_FOLDERS), 'ENOENT');
  });
});

describe('the names a separator or mod may take', () => {
  const SEPARATOR_CLASH = 'A separator with this name already exists';
  const MOD_CLASH = 'A mod with this name already exists';
  type Held = Pick<ModlistEntry, 'kind' | 'name'>;

  function commandsHolding(listed: readonly ModlistEntry[], folders: readonly Held[] = []) {
    const named = (kind: ModlistEntry['kind'], name: string) =>
      (e: Held) => e.kind === kind && e.name.toLowerCase() === name.toLowerCase();
    return modlistCommands({
      ...adapterOver('/instance'),
      orderEntry: (_profile, { kind, name }) => Promise.resolve(listed.find(named(kind, name))),
      entryFolder: ({ kind, name }) =>
        Promise.resolve(folders.filter(named(kind, name)).map((e) => ({ ...e, path: `/instance/mods/${e.name}` }))[0]),
    });
  }

  it('refuses a separator a name another separator\'s folder holds, and takes its own name or a mod\'s', async () => {
    const commands = commandsHolding([], [
      { kind: 'separator', name: 'Group A' }, { kind: 'separator', name: 'Group B' }, { kind: 'mod', name: 'Mod A' }]);

    expect(await commands.separatorNameRefusal('Default', 'group a', 'Group B')).toBe(SEPARATOR_CLASH);
    expect(await commands.separatorNameRefusal('Default', 'GROUP B', 'Group B')).toBeUndefined();
    expect(await commands.separatorNameRefusal('Default', 'Mod A', 'Group B')).toBeUndefined();
  });

  it('refuses a separator a name a separator with no folder has, since a line in mod order is a separator whose folder may be gone', async () => {
    const commands = commandsHolding([
      { kind: 'separator', name: 'Group A', enabled: true }, { kind: 'mod', name: 'Mod A', enabled: true }, { kind: 'separator', name: 'Group B', enabled: true }]);

    expect(await commands.separatorNameRefusal('Default', 'group a', 'Group B')).toBe(SEPARATOR_CLASH);
    expect(await commands.separatorNameRefusal('Default', 'GROUP B', 'Group B')).toBeUndefined();
    expect(await commands.separatorNameRefusal('Default', 'Mod A', 'Group B')).toBeUndefined();
  });

  it('refuses a mod a name another mod has, listed or in a folder, and a path separator, and takes its own name', async () => {
    const commands = commandsHolding(
      [{ kind: 'mod', name: 'Mod A', enabled: true }, { kind: 'mod', name: 'Mod B', enabled: true }, { kind: 'mod', name: 'Listed Only', enabled: true }],
      [{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }, { kind: 'mod', name: 'Folder Only' }]);

    expect(await commands.renameModNameRefusal('Default', 'mod a', 'Mod B')).toBe(MOD_CLASH);
    expect(await commands.renameModNameRefusal('Default', 'Folder Only', 'Mod B')).toBe(MOD_CLASH);
    expect(await commands.renameModNameRefusal('Default', 'Listed Only', 'Mod B')).toBe(MOD_CLASH);
    expect(await commands.renameModNameRefusal('Default', 'a/b', 'Mod B')).toBe('A mod name cannot contain / or \\');
    expect(await commands.renameModNameRefusal('Default', 'a\\b', 'Mod B')).toBe('A mod name cannot contain / or \\');
    expect(await commands.renameModNameRefusal('Default', 'mod b', 'Mod B')).toBeUndefined();
    expect(await commands.renameModNameRefusal('Default', 'Fresh', 'Mod B')).toBeUndefined();
  });
});
