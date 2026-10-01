import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { present } from '../../ports/present';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

// Delay is 0 by default (a passthrough), so only the concurrent-write test below opts in.
const fsState = vi.hoisted(() => {
  type ReadFile = typeof import('node:fs/promises')['readFile'];
  // `accessAnswered` lists each path `access` has answered for, in order.
  const state: { real: ReadFile | undefined; delayMs: number; accessAnswered: string[] } =
    { real: undefined, delayMs: 0, accessAnswered: [] };
  return state;
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsState.real = actual.readFile;
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    // Set immediately above, before any test can call through the mock.
    const result = await present(fsState.real, "the real readFile, captured before this mock's first call")(...args);
    if (fsState.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fsState.delayMs));
    return result;
  });
  const writeFile = vi.fn(actual.writeFile);
  const mkdir = vi.fn(actual.mkdir);
  const rename = vi.fn(actual.rename);
  const access = vi.fn(async (...args: Parameters<typeof actual.access>) => {
    try {
      await actual.access(...args);
    } finally {
      fsState.accessAnswered.push(String(args[0]));
    }
  });
  const readdir = vi.fn(actual.readdir);
  const stat = vi.fn(actual.stat);
  const lstat = vi.fn(actual.lstat);
  const rm = vi.fn(actual.rm);
  return { ...actual, readFile, writeFile, mkdir, rename, access, readdir, stat, lstat, rm };
});

import {
  access, cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';

// Every call through the mock that takes a path, so a test can say which paths were reached.
const pathCalls = (): (readonly unknown[])[][] => [
  vi.mocked(access).mock.calls, vi.mocked(stat).mock.calls, vi.mocked(lstat).mock.calls,
  vi.mocked(readdir).mock.calls, vi.mocked(readFile).mock.calls, vi.mocked(writeFile).mock.calls,
  vi.mocked(mkdir).mock.calls, vi.mocked(rename).mock.calls, vi.mocked(rm).mock.calls,
];
const pathsReached = (): string[] =>
  pathCalls().flatMap((calls) => calls.flatMap((args) => args.filter((a): a is string => typeof a === 'string')));
const forgetPathsReached = (): void => {
  for (const op of [access, stat, lstat, readdir, readFile, writeFile, mkdir, rename, rm]) vi.mocked(op).mockClear();
};
const listedDirs = (dir: string): string[] => {
  const probed = MOD_FOLDERS.map((name) => join(dir, 'mods', name));
  return vi.mocked(readdir).mock.calls.map(([path]) => String(path)).filter((path) => !probed.includes(path));
};
import {
  createEmptyMod,
  deleteSeparators,
  insertSeparator,
  moveMods,
  moveSeparators,
  renameSeparator,
  setModsEnabled,
  syncMods,
  uninstallMods,
} from '../modlist';
import { accessTo, adapterOver, readModlistEntries } from '../../test/mo2/adapterOver';
import type { ModFolder } from '../../instanceAdapter/instanceAdapter';

const fixture = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance');

// The fixture's own mods/ folders, as the value lists them for the new-empty-mod refusal.
const MOD_FOLDERS = [
  'Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k', 'Harder VATS',
  'SKK Fast Start new game (Fallout 4)', 'Unassigned (Modlist Development)_separator',
  'Unofficial Fallout 4 Patch',
];
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

// The folders named, as a value lists them: each as the adapter answers it, and one gone from disk
// since as the mod it held.
async function foldersIn(root: string, names: readonly string[]): Promise<ModFolder[]> {
  const listed = (await adapterOver(root).modFolders())?.all ?? [];
  return names.map((name) => {
    const path = join(root, 'mods', name);
    return listed.find((folder) => folder.path === path) ?? { kind: 'mod', name, path };
  });
}

// expect.stringContaining/expect.any(String) are both typed `any`, so this narrows the refusal
// branch by hand instead of embedding a matcher in a toEqual object.
function assertRefusal(result: { applied: boolean; refusal?: string }, expectedSubstring?: string): void {
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
    await cp(fixture, dir, { recursive: true });
    await utimes(modlistPath(), LONG_AGO, LONG_AGO);
  });
  afterEach(async () => {
    fsState.delayMs = 0;
    await rm(dir, { recursive: true, force: true });
  });

  // Rival: unserialized read-then-write. Both reads land pre-mutation before either write, so
  // the second write clobbers the first — a forced interleave, not scheduler luck.
  it('serializes two concurrent writes to the same modlist.txt — neither edit is lost', async () => {
    fsState.delayMs = 20;
    const [a, b] = await Promise.all([
      setModsEnabled(accessTo(dir), 'Default', ['Harder VATS'], true),
      setModsEnabled(accessTo(dir), 'Default', ['ENBoost - 12k'], false),
    ]);
    expect(a).toEqual({ applied: true, outcome: { landed: ['Harder VATS'], refused: [] } });
    expect(b).toEqual({ applied: true, outcome: { landed: ['ENBoost - 12k'], refused: [] } });
    const entries = await readModlist();
    expect(entries.find((e) => e.name === 'Harder VATS')?.enabled).toBe(true);
    expect(entries.find((e) => e.name === 'ENBoost - 12k')?.enabled).toBe(false);
  });

  it('setModsEnabled flips only the mods not already in the chosen state, in one write', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    vi.mocked(rename).mockClear();

    const outcome = await setModsEnabled(accessTo(dir), 'Default', ['Harder VATS', 'ENBoost - 12k'], true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Harder VATS', 'ENBoost - 12k'], refused: [] } });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
    expect(vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath())).toHaveLength(1);
  });

  it('setModsEnabled to a selection already in the chosen state writes nothing', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await setModsEnabled(accessTo(dir), 'Default', ['ENBoost - 12k', 'SKK Fast Start new game (Fallout 4)'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['ENBoost - 12k', 'SKK Fast Start new game (Fallout 4)'], refused: [] },
    });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('setModsEnabled refuses a gone mod by name while the rest land, in one write', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    vi.mocked(rename).mockClear();

    const outcome = await setModsEnabled(accessTo(dir), 'Default', ['Harder VATS', 'No Such Mod'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: ['Harder VATS'],
        refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }],
      },
    });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
    expect(vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath())).toHaveLength(1);
  });

  // Rival: a splice per mod, each catching its own read failure into a per-item refusal, which
  // answers applied:true with one reason repeated per mod.
  it('refuses the whole selection once, before any write, when modlist.txt cannot be read', async () => {
    await rm(modlistPath());

    const outcome = await setModsEnabled(accessTo(dir), 'Default', ['Harder VATS', 'ENBoost - 12k'], true);

    assertRefusal(outcome, 'ENOENT');
    await expect(stat(modlistPath())).rejects.toThrow();
  });

  it('insertSeparator writes a new enabled separator line after the named entry', async () => {
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    const idx = entries.findIndex((e) => e.name === 'ENBoost - 12k');
    expect(entries[idx + 1]).toEqual({ kind: 'separator', name: 'New Section', enabled: true });
  });

  it('insertSeparator on a mod inside a separator splits it: the mods on the anchor\'s winning side join the new one', async () => {
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: '[NODELETE] Radfall' });
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
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'Harder VATS' });
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
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' });
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
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'separator', name: 'Unassigned (Modlist Development)' });
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

    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'separator', name: 'SecondGroup' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual(['FirstGroup', 'New Section', 'SecondGroup', 'SKK Fast Start new game (Fallout 4)']);
  });

  it('insertSeparator makes the separator\'s folder beside its new line', async () => {
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await stat(join(dir, 'mods', 'New Section_separator'))).isDirectory()).toBe(true);
  });

  it('insertSeparator whose folder cannot be made refuses with the reason and leaves modlist.txt as it was', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('permission denied'));

    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });

    assertRefusal(outcome, 'permission denied');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('insertSeparator whose line cannot be written refuses with the reason and makes no folder', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'ENBoost - 12k' });

    assertRefusal(outcome, 'disk full');
    await expect(stat(join(dir, 'mods', 'New Section_separator'))).rejects.toThrow();
  });

  it('renameSeparator to its own name, as MO2 would name its folder, writes nothing', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', ' Unassigned (Modlist Development). ');

    expect(outcome).toEqual({ applied: true, wrote: false });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('insertSeparator refuses a name another separator has, writing neither line nor folder', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await insertSeparator(accessTo(dir), 'Default', 'Radfall - All-In-One Survival Overhaul', { kind: 'mod', name: 'ENBoost - 12k' });

    assertRefusal(outcome, 'Separator already in modlist: Radfall - All-In-One Survival Overhaul');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    await expect(stat(join(dir, 'mods', 'Radfall - All-In-One Survival Overhaul_separator'))).rejects.toThrow();
  });

  it('insertSeparator takes a name a mod has: a mod is no clash', async () => {
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'Harder VATS', { kind: 'mod', name: 'ENBoost - 12k' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await readModlist()).filter((e) => e.name === 'Harder VATS').map((e) => e.kind)).toEqual(['separator', 'mod']);
  });

  it('insertSeparator anchors on the entry of the kind it is handed, when a mod and a separator share its name', async () => {
    await writeFile(modlistPath(), '+Armor\r\n+Gear_separator\r\n+Gear\r\n', 'utf8');

    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'Gear' });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await readFile(modlistPath(), 'utf8')).toBe('+Armor\r\n+Gear_separator\r\n+Gear\r\n+New Section_separator\r\n');
  });

  // MO2 filters a separator's name as it filters every folder name under mods/
  // (MOBase::fixDirectoryName), so no name reaches a folder outside mods/<name>_separator/.
  describe('a separator name filtered as MO2 filters a folder name', () => {
    it('insertSeparator drops path separators, so ../x and A/B stay folders inside mods/', async () => {
      await insertSeparator(accessTo(dir), 'Default', '../Escape', { kind: 'mod', name: 'ENBoost - 12k' });
      await insertSeparator(accessTo(dir), 'Default', 'A/B', { kind: 'mod', name: 'ENBoost - 12k' });

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

      const outcome = await insertSeparator(accessTo(dir), 'Default', 'CON', { kind: 'mod', name: 'ENBoost - 12k' });

      expect(outcome).toEqual({ applied: false, refusal: 'Not a valid separator name: "CON"' });
      expect(await readFile(modlistPath(), 'utf8')).toBe(before);
      expect(await readdir(join(dir, 'mods'))).toEqual(foldersBefore);
    });

    it('renameSeparator drops path separators from the new name, so its folder stays inside mods/', async () => {
      await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', '../Escape');

      expect((await readModlist()).some((e) => e.kind === 'separator' && e.name === '..Escape')).toBe(true);
      expect((await stat(join(dir, 'mods', '..Escape_separator'))).isDirectory()).toBe(true);
      expect(await readdir(dir)).not.toContain('Escape_separator');
    });

    // A line another tool wrote, naming a folder no filtered name could reach.
    it('a separator line whose name escapes mods/ is renamed and deleted on its line alone', async () => {
      await writeFile(modlistPath(), '+../Escape_separator\r\n+Harder VATS\r\n', 'utf8');
      const outside = join(dir, 'Escape_separator');
      await mkdir(outside);
      const trashed: string[] = [];

      await renameSeparator(accessTo(dir), 'Default', '../Escape', 'Inside');
      await deleteSeparators(accessTo(dir), 'Default', ['Inside'], (path) => {
        trashed.push(path);
        return Promise.resolve();
      });
      await writeFile(modlistPath(), '+../Escape_separator\r\n', 'utf8');
      await deleteSeparators(accessTo(dir), 'Default', ['../Escape'], (path) => {
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
    const outcome = await insertSeparator(accessTo(dir), 'Default', 'New Section', { kind: 'mod', name: 'No Such Entry' });
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('renameSeparator rewrites the separator line in place', async () => {
    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Renamed');
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    expect(entries.some((e) => e.name === 'Renamed' && e.kind === 'separator')).toBe(true);
    expect(entries.some((e) => e.name === 'Unassigned (Modlist Development)')).toBe(false);
  });

  it('renameSeparator renames the separator\'s folder with its line', async () => {
    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Renamed');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await stat(join(dir, 'mods', 'Renamed_separator'))).isDirectory()).toBe(true);
    await expect(stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).rejects.toThrow();
  });

  it('renameSeparator of a separator with no folder renames the line alone and makes no folder', async () => {
    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Radfall - All-In-One Survival Overhaul', 'Renamed');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await readModlist()).some((e) => e.kind === 'separator' && e.name === 'Renamed')).toBe(true);
    await expect(stat(join(dir, 'mods', 'Renamed_separator'))).rejects.toThrow();
  });

  it('renameSeparator refuses a name another separator has, writing neither line nor folder', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Radfall - All-In-One Survival Overhaul');

    assertRefusal(outcome, 'Separator already in modlist: Radfall - All-In-One Survival Overhaul');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect((await stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).isDirectory()).toBe(true);
    await expect(stat(join(dir, 'mods', 'Radfall - All-In-One Survival Overhaul_separator'))).rejects.toThrow();
  });

  it('renameSeparator takes a name a mod has: a mod is no clash', async () => {
    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Harder VATS');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await stat(join(dir, 'mods', 'Harder VATS_separator'))).isDirectory()).toBe(true);
  });

  it('renameSeparator whose folder cannot be renamed refuses with the reason and leaves modlist.txt as it was', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(new Error('folder in use'));

    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Renamed');

    assertRefusal(outcome, 'folder in use');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect((await stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).isDirectory()).toBe(true);
  });

  it('renameSeparator whose line cannot be written leaves the folder as it was', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

    const outcome = await renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Renamed');

    assertRefusal(outcome, 'disk full');
    expect((await stat(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'))).isDirectory()).toBe(true);
    await expect(stat(join(dir, 'mods', 'Renamed_separator'))).rejects.toThrow();
  });

  it('renameSeparator refuses an unknown separator', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await renameSeparator(accessTo(dir), 'Default', 'No Such Separator', 'Renamed');
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  describe('deleteSeparators', () => {
    const UNASSIGNED = 'Unassigned (Modlist Development)';
    const RADFALL = 'Radfall - All-In-One Survival Overhaul';
    const unassignedFolder = () => join(dir, 'mods', `${UNASSIGNED}_separator`);
    // The system trash, as the Ports hand it in: the path leaves mods/.
    const trashed: string[] = [];
    const trash = async (path: string) => {
      trashed.push(path);
      await rm(path, { recursive: true });
    };
    beforeEach(() => { trashed.length = 0; });

    const order = async () => (await readModlist()).map((e) => `${e.kind}:${e.name}`);

    it('removes the line and trashes the folder, and the mods it held join the separator above', async () => {
      const outcome = await deleteSeparators(accessTo(dir), 'Default', [UNASSIGNED], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: UNASSIGNED }], refused: [] } });
      expect(await order()).toEqual([
        'mod:SKK Fast Start new game (Fallout 4)', 'mod:[NODELETE] Radfall', 'mod:Unofficial Fallout 4 Patch',
        `separator:${RADFALL}`, 'mod:ENBoost - 12k', 'mod:Harder VATS', 'mod:Cracked and Smudged Pip-Boy Screen',
      ]);
      expect(trashed).toEqual([unassignedFolder()]);
    });

    it('the mods of the first separator become ungrouped', async () => {
      const outcome = await deleteSeparators(accessTo(dir), 'Default', [RADFALL], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: RADFALL }], refused: [] } });
      expect(await order()).toEqual([
        'mod:SKK Fast Start new game (Fallout 4)', `separator:${UNASSIGNED}`, 'mod:[NODELETE] Radfall',
        'mod:Unofficial Fallout 4 Patch', 'mod:ENBoost - 12k', 'mod:Harder VATS', 'mod:Cracked and Smudged Pip-Boy Screen',
      ]);
    });

    it('removes every selected line in one write', async () => {
      vi.mocked(rename).mockClear();

      const outcome = await deleteSeparators(accessTo(dir), 'Default', [UNASSIGNED, RADFALL], trash);

      expect(outcome).toEqual({
        applied: true, outcome: { landed: [{ name: UNASSIGNED }, { name: RADFALL }], refused: [] },
      });
      expect((await readModlist()).every((e) => e.kind === 'mod')).toBe(true);
      expect(vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath())).toHaveLength(1);
    });

    // The gone separator's folder is still under mods/, as MO2 or another tool may leave it.
    it('refuses a gone separator by name while the others land, in one write, trashing nothing for it', async () => {
      await mkdir(join(dir, 'mods', 'No Such Separator_separator'));
      vi.mocked(rename).mockClear();

      const outcome = await deleteSeparators(accessTo(dir), 'Default', ['No Such Separator', UNASSIGNED], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: UNASSIGNED }],
          refused: [{ item: { name: 'No Such Separator' }, reason: 'Separator not found in modlist: No Such Separator' }],
        },
      });
      expect(trashed).toEqual([unassignedFolder()]);
      expect(vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath())).toHaveLength(1);
    });

    it('refuses the whole selection once and trashes nothing when modlist.txt cannot be read', async () => {
      await rm(modlistPath());

      const outcome = await deleteSeparators(accessTo(dir), 'Default', [UNASSIGNED, RADFALL], trash);

      assertRefusal(outcome, 'ENOENT');
      expect(trashed).toEqual([]);
    });

    // UNASSIGNED's folder is trashed; RADFALL's never existed, so nothing was trashed for it.
    it('a separator whose line cannot go after its folder was trashed still lands, carrying the part that failed', async () => {
      const before = await readFile(modlistPath(), 'utf8');
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      const outcome = await deleteSeparators(accessTo(dir), 'Default', [UNASSIGNED, RADFALL], trash);

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

    // mods.md, Reporting, story 3: the line a delete leaves after the trash names a folder that
    // is gone. Rival: mod sync dropping only mod lines, so the deleted separator stays for good.
    it('the line a delete leaves after the trash is dropped by the next mod sync', async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
      await deleteSeparators(accessTo(dir), 'Default', [UNASSIGNED], trash);
      expect(await order()).toContain(`separator:${UNASSIGNED}`);

      const outcome = await syncMods(accessTo(dir), 'Default', await foldersIn(dir, await readdir(join(dir, 'mods'))));

      expect(outcome.applied && outcome.dropped).toContain(`${UNASSIGNED} (separator)`);
      expect(await order()).not.toContain(`separator:${UNASSIGNED}`);
    });

    it('writes nothing for a separator whose folder the trash refuses, and refuses it with the reason, while the others land', async () => {
      const before = await readFile(modlistPath(), 'utf8');
      const refusingTrash = async (path: string) => {
        if (path === unassignedFolder()) throw new Error('trash unavailable');
        await trash(path);
      };

      const outcome = await deleteSeparators(accessTo(dir), 'Default', [UNASSIGNED, RADFALL], refusingTrash);

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
    const outcome = await moveMods(accessTo(dir), 'Default', ['Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k'],
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
    const outcome = await moveMods(accessTo(dir), 'Default', ['Unofficial Fallout 4 Patch', 'SKK Fast Start new game (Fallout 4)'], { kind: 'ungrouped' }, 'losing');

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
    const outcome = await moveMods(accessTo(dir), 'Default', ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'],
      { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

    expect(outcome).toEqual({
      applied: true, outcome: { landed: ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'], refused: [] },
    });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('moveMods refuses a gone mod by name while the others land, in one write', async () => {
    vi.mocked(rename).mockClear();

    const outcome = await moveMods(accessTo(dir), 'Default', ['No Such Mod', 'Harder VATS'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    const names = (await readModlist()).map((e) => e.name);
    expect(names.slice(0, 3)).toEqual([
      'SKK Fast Start new game (Fallout 4)', 'Harder VATS', 'Unassigned (Modlist Development)',
    ]);
    expect(vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath())).toHaveLength(1);
  });

  it('moveMods to a separator that has gone refuses the whole move, naming it', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await moveMods(accessTo(dir), 'Default', ['Harder VATS'], { kind: 'separator', name: 'Gone Separator' }, 'losing');

    assertRefusal(outcome, 'Gone Separator');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('moveMods beside a mod that has gone refuses the whole move, naming it', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await moveMods(accessTo(dir), 'Default', ['Harder VATS'], { kind: 'mod', name: 'Gone Mod' }, 'losing');

    assertRefusal(outcome, 'Gone Mod');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('moveMods refuses the whole selection once when modlist.txt cannot be read', async () => {
    await rm(modlistPath());

    const outcome = await moveMods(accessTo(dir), 'Default', ['Harder VATS', 'ENBoost - 12k'], { kind: 'ungrouped' }, 'losing');

    assertRefusal(outcome, 'ENOENT');
    await expect(stat(modlistPath())).rejects.toThrow();
  });

  it('moveSeparators on the losing side lands each separator with its mods directly on the losing side of the chosen one', async () => {
    const outcome = await moveSeparators(accessTo(dir), 'Default', ['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

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
    const outcome = await moveSeparators(accessTo(dir), 'Default', ['Radfall - All-In-One Survival Overhaul'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Radfall - All-In-One Survival Overhaul'], refused: [] } });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('moveSeparators refuses a gone separator by name while the others land', async () => {
    const outcome = await moveSeparators(accessTo(dir), 'Default', ['Gone Separator', 'Unassigned (Modlist Development)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

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

    const outcome = await moveSeparators(accessTo(dir), 'Default', ['Unassigned (Modlist Development)'], { kind: 'separator', name: 'Gone Separator' }, 'losing');

    assertRefusal(outcome, 'Gone Separator');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  describe('uninstallMods', () => {
    const ARCHIVE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
    const metaPath = () => join(dir, 'downloads', `${ARCHIVE}.meta`);
    const trashed: string[] = [];
    const trash = vi.fn(async (path: string) => {
      trashed.push(path);
      await rm(path, { recursive: true });
    });
    beforeEach(() => { trashed.length = 0; trash.mockClear(); });

    // Order is the one property this suite cannot read off the end state alone: every mock
    // vitest hands out shares one call-order counter, trash included.
    const writeOrderOf = (path: string): number => {
      const callIdx = vi.mocked(rename).mock.calls.findIndex(([, to]) => to === path);
      return present(vi.mocked(rename).mock.invocationCallOrder[callIdx], `a rename landing ${path}`);
    };

    it('trashes the folder, then removes the line, then marks the download uninstalled, in that order', async () => {
      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true, outcome: { landed: [{ name: 'Unofficial Fallout 4 Patch' }], refused: [] },
      });
      expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
      await expect(stat(join(dir, 'mods', 'Unofficial Fallout 4 Patch'))).rejects.toThrow();
      expect(await readFile(metaPath(), 'utf8')).toContain('uninstalled=true');

      const [trashOrder] = trash.mock.invocationCallOrder;
      expect(trashOrder).toBeLessThan(writeOrderOf(modlistPath()));
      expect(writeOrderOf(modlistPath())).toBeLessThan(writeOrderOf(metaPath()));
    });

    // A line another tool wrote with a `/` names no folder under mods/. Rival: joining the raw
    // name onto mods/, which trashes a folder outside it.
    it('trashes nothing outside mods/ for a mod whose name escapes it, and still drops its line', async () => {
      const outside = join(dir, 'Escaped');
      await mkdir(outside);
      await writeFile(modlistPath(), `+../Escaped\r\n${await readFile(modlistPath(), 'utf8')}`);

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: '../Escaped' }], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: '../Escaped' }], refused: [] } });
      expect(trashed).toEqual([]);
      expect((await stat(outside)).isDirectory()).toBe(true);
      expect((await readModlist()).some((e) => e.name === '../Escaped')).toBe(false);
    });

    it('removes every selected mod\'s line in one write', async () => {
      vi.mocked(rename).mockClear();

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Harder VATS' }, { name: 'ENBoost - 12k' }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: { landed: [{ name: 'Harder VATS' }, { name: 'ENBoost - 12k' }], refused: [] },
      });
      expect(vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath())).toHaveLength(1);
    });

    it('refuses an unknown mod by name, trashing and marking nothing for it, while the rest land', async () => {
      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'No Such Mod' }, { name: 'Harder VATS' }], trash);

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

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Harder VATS' }], trash);

      assertRefusal(outcome, 'ENOENT');
      expect(trashed).toEqual([]);
    });

    it('writes nothing for a mod whose folder the trash refuses, refusing it with the reason, while the others land and mark', async () => {
      const failingFolder = join(dir, 'mods', 'Harder VATS');
      // A real archive of its own, so "its downloaded file untouched" is a claim that could fail.
      const HARDER_VATS_ARCHIVE = 'Harder VATS-1-0.7z';
      const harderVatsMetaPath = join(dir, 'downloads', `${HARDER_VATS_ARCHIVE}.meta`);
      await writeFile(join(dir, 'downloads', HARDER_VATS_ARCHIVE), '');
      await writeFile(harderVatsMetaPath, '[General]\r\ninstalled=true\r\n');
      const refusingTrash = vi.fn(async (path: string) => {
        if (path === failingFolder) throw new Error('trash unavailable');
        await trash(path);
      });

      const outcome = await uninstallMods(accessTo(dir), 'Default',
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
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: 'Unofficial Fallout 4 Patch', lineRefusal: 'disk full' }],
          refused: [],
        },
      });
      expect(await readFile(metaPath(), 'utf8')).not.toContain('uninstalled=true');
    });

    it('carries a failed mark on the landed item rather than refusing it, and leaves the download unmarked', async () => {
      const passthrough = present(vi.mocked(writeFile).getMockImplementation(), 'the writeFile passthrough');
      vi.mocked(writeFile).mockImplementationOnce(passthrough).mockRejectedValueOnce(new Error('disk full'));

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: { landed: [{ name: 'Unofficial Fallout 4 Patch', markRefusal: 'disk full' }], refused: [] },
      });
      expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
      expect(await readFile(metaPath(), 'utf8')).not.toContain('uninstalled=true');
    });

    // Rival: skipping the mark when the downloads folder cannot be resolved, which leaves the
    // downloaded file claiming a mod that is gone with nothing said.
    it('carries the mark\'s refusal when the downloads folder cannot be resolved', async () => {
      const unresolved = new Error('download_directory "Z:\\gone" could not be resolved');
      const adapter = { ...adapterOver(dir), markDownloadedFile: () => Promise.reject(unresolved) };

      const outcome = await uninstallMods(
        { adapter }, 'Default', [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);

      expect(outcome).toEqual({
        applied: true,
        outcome: { landed: [{ name: 'Unofficial Fallout 4 Patch', markRefusal: unresolved.message }], refused: [] },
      });
      expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
    });

    // A mod outlives the download it came from, so an uninstall can name an archive that is gone,
    // and a sidecar beside no archive is a file MO2 would never write.
    it('writes no sidecar for an archive that is absent from downloads/', async () => {
      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Harder VATS', archiveFilename: 'Long Gone-1-0.7z' }], trash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
      await expect(stat(join(dir, 'downloads', 'Long Gone-1-0.7z.meta'))).rejects.toThrow();
    });

    // Another tool rewrites the line in another case once the folder has gone. Rival: matching the
    // line by the name the view listed, which keeps it and reports the uninstall whole.
    it('drops a line whose case changed after the folder went', async () => {
      const recasingTrash = async (path: string) => {
        await trash(path);
        await writeFile(modlistPath(), (await readFile(modlistPath(), 'utf8')).replace('-Harder VATS', '-harder vats'));
      };

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Harder VATS' }], recasingTrash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
      expect((await readModlist()).some((e) => e.name.toLowerCase() === 'harder vats')).toBe(false);
    });

    // Mod sync hears the trashed folder and drops its line before the uninstall does. Rival: a drop
    // of a line already gone refused, reporting a landed uninstall as part failed.
    it('lands whole when mod sync dropped the line after the folder went', async () => {
      const syncingTrash = async (path: string) => {
        await trash(path);
        await syncMods(accessTo(dir), 'Default', []);
      };

      const outcome = await uninstallMods(accessTo(dir), 'Default', [{ name: 'Harder VATS' }], syncingTrash);

      expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
      expect((await readModlist()).some((e) => e.name === 'Harder VATS')).toBe(false);
    });
  });

  describe('createEmptyMod', () => {
    // MO2 keys mods by name without case (modinfo.cpp, FileNameComparator), and a Windows folder
    // answers to either case. Rival: an exact match, which joins onto the existing folder and
    // writes a second line for it.
    it('refuses a name a mod folder already has in another case', async () => {
      assertRefusal(await createEmptyMod(accessTo(dir), 'Default', 'harder vats'), 'already exists');
    });

    // Rival: an exact match against the lines, which doubles a line a mod sync already wrote.
    it('leaves a line mod sync already wrote in another case, rather than doubling it', async () => {
      await writeFile(modlistPath(), `-new mod\r\n${await readFile(modlistPath(), 'utf8')}`);

      const outcome = await createEmptyMod(accessTo(dir), 'Default', 'New Mod');

      expect(outcome).toEqual({ applied: true, wrote: false });
      expect((await readModlist()).filter((e) => e.name.toLowerCase() === 'new mod')).toHaveLength(1);
    });

    // MO2 knows a mod by its folder's name, and this one is a separator's. Rival: asking for a mod
    // of that name, which reads it as free and writes a second line for the separator's folder.
    it('refuses a name a separator\'s folder has, writing no line', async () => {
      const before = await readFile(modlistPath(), 'utf8');
      const name = 'Unassigned (Modlist Development)_separator';

      const outcome = await createEmptyMod(accessTo(dir), 'Default', name);

      expect(outcome).toEqual({
        applied: false,
        refusal: `A mod named "${name}" already exists — install its next release from the Downloads view instead.`,
      });
      expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    });

    // Rival: joining the prompt's name onto mods/ raw, which makes a folder outside it.
    it('refuses a name that would leave mods/, making no folder anywhere', async () => {
      assertRefusal(await createEmptyMod(accessTo(dir), 'Default', '../x'), 'Not a valid mod name');

      expect(await readdir(dir)).not.toContain('x');
      expect((await readModlist()).some((e) => e.name === '../x')).toBe(false);
    });

    it('creates an empty folder under mods/ and a disabled modlist line', async () => {
      const outcome = await createEmptyMod(accessTo(dir), 'Default', 'My New Mod');
      expect(outcome).toEqual({ applied: true, wrote: true });
      expect((await stat(join(dir, 'mods', 'My New Mod'))).isDirectory()).toBe(true);
      expect(await readdir(join(dir, 'mods', 'My New Mod'))).toEqual([]);
      const entries = await readModlist();
      expect(entries.find((e) => e.name === 'My New Mod')).toEqual({ kind: 'mod', name: 'My New Mod', enabled: false });
    });

    // insertModAtWinningEnd always lands above whatever is currently first, so the new line is
    // entries[0] deterministically — the fixture's own winning-most mod moves to entries[1].
    it('lands the line at the winning end, disabled, exactly once, with the folder on disk', async () => {
      const outcome = await createEmptyMod(accessTo(dir), 'Default', 'Winning End Mod');

      expect(outcome).toEqual({ applied: true, wrote: true });
      const entries = await readModlist();
      expect(entries[0]).toEqual({ kind: 'mod', name: 'Winning End Mod', enabled: false });
      expect(entries.filter((e) => e.name === 'Winning End Mod')).toHaveLength(1);
      expect((await stat(join(dir, 'mods', 'Winning End Mod'))).isDirectory()).toBe(true);
    });

    // The other half of "folder first": a failed folder write leaves no line, proven from the
    // opposite direction of the line-write-fails test below.
    // Rival: splice modlist.txt before (or without regard to) the folder write.
    it('writes no line when the folder write itself fails', async () => {
      vi.mocked(mkdir).mockRejectedValueOnce(new Error('permission denied'));
      const beforeModlist = await readFile(modlistPath(), 'utf8');

      assertRefusal(await createEmptyMod(accessTo(dir), 'Default', 'Folder Write Fails'), 'permission denied');

      expect(await readFile(modlistPath(), 'utf8')).toBe(beforeModlist);
    });

    // Rival: refuse only what the modlist lists. A folder MO2 dropped in with no line would
    // then be clobbered by a new empty mod of the same name.
    it('refuses a name the value already lists as a folder, clobbering neither it nor the modlist', async () => {
      const beforeModlist = await readFile(modlistPath(), 'utf8');
      const before = await readdir(join(dir, 'mods', 'Harder VATS'));
      const outcome = await createEmptyMod(accessTo(dir), 'Default', 'Harder VATS');
      assertRefusal(outcome, 'Harder VATS');
      expect(await readdir(join(dir, 'mods', 'Harder VATS'))).toEqual(before);
      expect(await readFile(modlistPath(), 'utf8')).toBe(beforeModlist);
    });

    // On disk with no modlist.txt line — mod sync has not caught up yet.
    // Install's own words for the same collision are held to this one in src/test.
    it('refuses a lineless folder as a name that already exists', async () => {
      await mkdir(join(dir, 'mods', 'Lineless Folder'));

      const outcome = await createEmptyMod(accessTo(dir), 'Default', 'Lineless Folder');

      expect(outcome.applied).toBe(false);
      expect(!outcome.applied && outcome.refusal).toMatch(/"Lineless Folder" already exists/);
    });

    // Models mod sync winning the race against this command's own line write.
    // Rival: insert unconditionally. That doubles the line here.
    it('writes no second line when mod sync already added it, and reports no failure', async () => {
      const name = 'Synced In First';
      await adapterOver(dir).changeModOrder('Default', () => [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name } }]);

      const outcome = await createEmptyMod(accessTo(dir), 'Default', name);

      expect(outcome).toEqual({ applied: true, wrote: false });
      expect((await stat(join(dir, 'mods', name))).isDirectory()).toBe(true);
      expect((await readModlist()).filter((e) => e.name === name)).toHaveLength(1);
    });

    // Rival: fold the line's failure back into `applied: false`. The folder is on disk either
    // way, so that reports a landed create as failed.
    it('a failed line write leaves the folder in place and answers a partial, not a refusal', async () => {
      const name = 'Line Write Fails';
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      const outcome = await createEmptyMod(accessTo(dir), 'Default', name);

      expect(outcome.applied).toBe(true);
      if (!outcome.applied) throw new Error('expected applied: true');
      expect(outcome.wrote).toBe(false);
      expect(outcome.lineRefusal).toMatch(/disk full/);
      expect((await stat(join(dir, 'mods', name))).isDirectory()).toBe(true);
      expect((await readModlist()).some((e) => e.name === name)).toBe(false);
    });
  });
});

describe('syncMods — modlist.txt brought into line with the folders in mods/ it is handed', () => {
  let dir: string;
  const modlistPath = () => join(dir, 'profiles', 'Default', 'modlist.txt');
  const readModlist = () => readModlistEntries(dir);
  const writesToModlist = () => vi.mocked(rename).mock.calls.filter(([, to]) => to === modlistPath()).length;
  const sync = async (folders: readonly string[]) => syncMods(accessTo(dir), 'Default', await foldersIn(dir, folders));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-sync-'));
    await cp(fixture, dir, { recursive: true });
    vi.mocked(rename).mockClear();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // The fixture lists "[NODELETE] Radfall" and the "Radfall - All-In-One Survival Overhaul"
  // separator, neither of whose folders is among MOD_FOLDERS.
  // Rival: two splices, one per direction, which writes the file twice.
  it('adds a line for a folder with none and drops each line whose folder is gone, in one write', async () => {
    await mkdir(join(dir, 'mods', 'Hand Extracted Mod'));
    vi.mocked(rename).mockClear();

    const outcome = await sync([...MOD_FOLDERS, 'Hand Extracted Mod']);

    expect(outcome).toEqual({
      applied: true, added: ['Hand Extracted Mod'],
      dropped: ['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)'],
    });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toContain('Hand Extracted Mod');
    expect(names).not.toContain('[NODELETE] Radfall');
    expect(writesToModlist()).toBe(1);
  });

  // Rival: a splice that always puts the bytes back, which fires the watcher and loops forever.
  it('writes nothing when every folder has a line and every mod line has a folder', async () => {
    await sync([...MOD_FOLDERS, '[NODELETE] Radfall']);
    vi.mocked(rename).mockClear();

    expect(await sync([...MOD_FOLDERS, '[NODELETE] Radfall'])).toEqual({ applied: true, added: [], dropped: [] });
    expect(writesToModlist()).toBe(0);
  });

  // The fixture's "Radfall - All-In-One Survival Overhaul" separator has no folder, and its
  // `*DLC: Automatron` line names none. Rival: dropping every line with no folder in mods/, the
  // game's own `*` lines included.
  it('drops only the mod and separator lines whose folder is gone: every other line stays', async () => {
    const before = (await readFile(modlistPath(), 'utf8')).split('\r\n');

    await sync(MOD_FOLDERS);

    const after = (await readFile(modlistPath(), 'utf8')).split('\r\n');
    expect(before.filter((line) => !after.includes(line))).toEqual([
      '+[NODELETE] Radfall', '-Radfall - All-In-One Survival Overhaul_separator',
    ]);
  });

  // mods.md, Reporting, story 2: `mods/` cannot be listed, so nothing is written. Rival:
  // reading a mods/ gone by write time as no folders, which drops every line.
  it('refuses, writing nothing, when mods/ is gone by the time the sync writes', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    await rm(join(dir, 'mods'), { recursive: true });
    vi.mocked(rename).mockClear();

    expect(await sync(MOD_FOLDERS)).toEqual({ applied: false, refusal: 'there is no folder for mods' });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(writesToModlist()).toBe(0);
  });

  it('refuses, writing nothing, when mods/ cannot be listed for another reason', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const folders = await foldersIn(dir, MOD_FOLDERS);
    await rm(join(dir, 'mods'), { recursive: true });
    await writeFile(join(dir, 'mods'), 'not a folder');
    vi.mocked(rename).mockClear();

    assertRefusal(await syncMods(accessTo(dir), 'Default', folders), 'ENOTDIR');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(writesToModlist()).toBe(0);
  });

  // MO2 lists a linked mod folder as a mod (modinfo.cpp, QDir::Dirs without NoSymLinks). Rival:
  // only a real directory counts, so a symlinked mod's line is dropped and never comes back.
  it('keeps the line of a mod whose folder is a link to a folder', async () => {
    const target = await mkdtemp(join(tmpdir(), 'linked-mod-'));
    try {
      await symlink(target, join(dir, 'mods', 'Linked Mod'), 'junction');
      await writeFile(modlistPath(), `+Linked Mod\r\n${await readFile(modlistPath(), 'utf8')}`);

      const outcome = await sync(MOD_FOLDERS);

      expect(outcome.applied && outcome.dropped).not.toContain('Linked Mod');
      expect(await readModlist()).toContainEqual({ kind: 'mod', name: 'Linked Mod', enabled: true });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  // MO2 skips a link it cannot follow, and has no mod by its name. Rival: refusing the whole sync
  // on it, so one bad link stops every line from syncing.
  it('skips a mod folder link whose target cannot be checked, and drops its line', async () => {
    await symlink(join(dir, 'mods', 'Loop'), join(dir, 'mods', 'Loop'));
    await writeFile(modlistPath(), `+Loop\r\n${await readFile(modlistPath(), 'utf8')}`);

    const outcome = await sync(MOD_FOLDERS);

    expect(outcome.applied && outcome.dropped).toContain('Loop');
  });

  // MO2 matches a line to its folder without case (FileNameComparator); a Linux disk does not.
  // Rival: looking up the line's own spelling on disk, which drops the line, state and place.
  it('keeps a line whose folder differs only in case, when the handed list misses it', async () => {
    await writeFile(modlistPath(), (await readFile(modlistPath(), 'utf8')).replace('-Harder VATS', '+harder vats'));
    const kept = (await readModlist())
      .filter((e) => e.name !== '[NODELETE] Radfall' && e.name !== 'Radfall - All-In-One Survival Overhaul');
    const lagging = MOD_FOLDERS.filter((f) => f !== 'Harder VATS');

    const outcome = await sync(lagging);

    expect(outcome.applied && outcome.dropped).toEqual(['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)']);
    expect(await readModlist()).toEqual(kept);
    expect(kept).toContainEqual({ kind: 'mod', name: 'harder vats', enabled: true });
  });

  // The value lags the disk: its folders were listed before a folder and its line landed, and the
  // sync splices the text as it is now. Rival: dropping by the handed list alone, which loses the
  // new line for good.
  it('keeps a line whose folder the handed list misses but that is on disk at write time', async () => {
    const lagging = MOD_FOLDERS.filter((f) => f !== 'Harder VATS' && f !== 'Unassigned (Modlist Development)_separator');

    const outcome = await sync(lagging);

    expect(outcome.applied && outcome.dropped).toEqual(['[NODELETE] Radfall', 'Radfall - All-In-One Survival Overhaul (separator)']);
    const names = (await readModlist()).map((e) => `${e.kind}:${e.name}`);
    expect(names).toEqual(expect.arrayContaining(['mod:Harder VATS', 'separator:Unassigned (Modlist Development)']));
  });

  // Another tool may write a name MO2 never gives a folder; MO2 has no mod by that name and drops
  // the line (ADR-0017). Rivals: keeping the line for good, or building a path from the name.
  it('drops a separator line whose name MO2 never gives a folder, building no path from it', async () => {
    await writeFile(modlistPath(), '-Weapons/Armor_separator\r\n+Harder VATS\r\n');
    const folders = await foldersIn(dir, MOD_FOLDERS);
    forgetPathsReached();

    expect(await syncMods(accessTo(dir), 'Default', folders)).toMatchObject({ applied: true, dropped: ['Weapons/Armor (separator)'] });
    expect(listedDirs(dir)).toEqual([join(dir, 'mods'), join(dir, 'profiles', 'Default')]);
    expect(pathsReached().filter((p) => p.includes('Weapons'))).toEqual([]);
    expect(await readFile(modlistPath(), 'utf8')).not.toContain('Weapons/Armor');
  });

  // A line another tool wrote with a `/` names no folder under mods/, and MO2 has no mod by that
  // name. Rival: joining the raw name onto mods/, which finds a folder outside it and keeps the line.
  it('drops a mod line whose name escapes mods/, looking at nothing outside it', async () => {
    const outside = join(dir, 'Escaped');
    await mkdir(outside);
    await writeFile(modlistPath(), '+../Escaped\r\n+Harder VATS\r\n');
    const folders = await foldersIn(dir, MOD_FOLDERS);
    forgetPathsReached();

    expect(await syncMods(accessTo(dir), 'Default', folders)).toMatchObject({ applied: true, dropped: ['../Escaped'] });
    expect(listedDirs(dir)).toEqual([join(dir, 'mods'), join(dir, 'profiles', 'Default')]);
    expect(pathsReached().filter((p) => p.includes('Escaped'))).toEqual([]);
  });

  // MO2 keys mods and separators by name without case (modinfo.cpp, FileNameComparator), and a
  // Windows folder answers to either case. Rival: comparing with case, which drops both lines and
  // adds a duplicate of each, the separator's as an orphan.
  it('matches a line to its folder without case', async () => {
    await writeFile(modlistPath(), '+harder vats\r\n-unassigned (modlist development)_separator\r\n');

    const outcome = await sync(MOD_FOLDERS);

    expect(outcome.applied && outcome.dropped).toEqual([]);
    expect(outcome.applied && outcome.added).not.toEqual(expect.arrayContaining(['Harder VATS']));
    expect(outcome.applied && outcome.added).not.toEqual(expect.arrayContaining(['Unassigned (Modlist Development) (separator)']));
  });

  it('adds a disabled separator line at the winning end for a separator folder with none', async () => {
    await mkdir(join(dir, 'mods', 'Orphan_separator'));

    const outcome = await sync([...MOD_FOLDERS, 'Orphan_separator']);

    expect(outcome.applied && outcome.added).toEqual(['Orphan (separator)']);
    expect((await readModlist())[0]).toEqual({ kind: 'separator', name: 'Orphan', enabled: false });
  });

  it('writes a batch of added lines ascending top-to-bottom, winning-most first', async () => {
    for (const name of ['Zeta Mod', 'Alpha Mod']) await mkdir(join(dir, 'mods', name));

    const outcome = await sync([...MOD_FOLDERS, 'Zeta Mod', 'Alpha Mod']);

    expect(outcome).toMatchObject({ applied: true, added: ['Alpha Mod', 'Zeta Mod'] });
    expect((await readModlist()).slice(0, 2)).toEqual([
      { kind: 'mod', name: 'Alpha Mod', enabled: false },
      { kind: 'mod', name: 'Zeta Mod', enabled: false },
    ]);
  });

  // A folder the lagging value still lists may be gone by write time, as a renamed separator's old
  // folder is. Rival: adding from the handed list alone, a ghost line the next sync drops again.
  it('adds no line for a folder the value lists but that is gone from disk at write time', async () => {
    await rename(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'), join(dir, 'mods', 'Renamed_separator'));
    await writeFile(modlistPath(), (await readFile(modlistPath(), 'utf8')).replace(
      'Unassigned (Modlist Development)_separator', 'Renamed_separator'));

    const outcome = await sync([...MOD_FOLDERS, 'Ghost Mod']);

    expect(outcome.applied && outcome.added).toEqual([]);
    const separators = (await readModlist()).filter((e) => e.kind === 'separator').map((e) => e.name);
    expect(separators).toContain('Renamed');
    expect(separators).not.toContain('Unassigned (Modlist Development)');
  });

  // The mods to sync arrive as an argument (target-architecture.md, Rules the Modbench column
  // draws); a folder landed since is the next value's. Rival: adding from the disk alone.
  it('adds no line for a folder on disk that the value does not list yet', async () => {
    await mkdir(join(dir, 'mods', 'Landed Since'));

    const outcome = await sync(MOD_FOLDERS);

    expect(outcome.applied && outcome.added).toEqual([]);
    expect((await readModlist()).map((e) => e.name)).not.toContain('Landed Since');
  });

  // The folder comes back while the sync waits its turn on modlist.txt. Rival: looking at the disk
  // before the write lock, which drops the line and loses its enabled state and its place.
  it('keeps a line whose folder is back on disk by the time the sync writes', async () => {
    const lagging = MOD_FOLDERS.filter((f) => f !== 'Harder VATS');
    const harderVats = join(dir, 'mods', 'Harder VATS');
    await rm(harderVats, { recursive: true });
    let reached = (): void => {};
    let release = (): void => {};
    const holding = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const realWrite = present(vi.mocked(writeFile).getMockImplementation(), 'the real writeFile');
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => { reached(); await released; return realWrite(...args); });
    const holder = setModsEnabled(accessTo(dir), 'Default', ['ENBoost - 12k'], false);
    await holding;
    const readsBefore = vi.mocked(readFile).mock.calls.filter(([p]) => p === modlistPath()).length;
    fsState.accessAnswered.length = 0;

    const syncing = sync(lagging);
    // Whatever the sync does before its turn is done before the folder comes back.
    await vi.waitFor(() => {
      const readEarly = vi.mocked(readFile).mock.calls.filter(([p]) => p === modlistPath()).length > readsBefore;
      expect(!readEarly || fsState.accessAnswered.includes(harderVats)).toBe(true);
    });
    await mkdir(harderVats);
    release();
    await holder;
    const outcome = await syncing;

    expect(outcome.applied && outcome.dropped).not.toContain('Harder VATS');
    expect(await readModlist()).toContainEqual({ kind: 'mod', name: 'Harder VATS', enabled: false });
  });

  it('refuses when modlist.txt cannot be read, rather than throwing', async () => {
    await rm(modlistPath());

    assertRefusal(await sync(MOD_FOLDERS), 'ENOENT');
  });
});

// A separator gesture makes or renames its folder, then writes its line. A mod sync whose value
// was listed in between leaves both alone: it decides only once the gesture is done.
describe('a mod sync between a separator gesture\'s folder and its line', () => {
  let dir: string;
  const readEntries = () => readModlistEntries(dir);
  const listedNow = () => readdir(join(dir, 'mods'));

  // The gesture waits in its gap until released, and says when it got there.
  function gap() {
    let reached = (): void => {};
    let release = (): void => {};
    const reachedGap = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    return { reachedGap, release, waitHere: async () => { reached(); await released; } };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-gap-'));
    await cp(fixture, dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // Rival: the sync deciding from folders it listed before the gesture was done, which drops the
  // new line whose folder it never saw.
  it('keeps the line of a separator being added', async () => {
    const hold = gap();
    const realMkdir = present(vi.mocked(mkdir).getMockImplementation(), 'the real mkdir');
    vi.mocked(mkdir).mockImplementationOnce(async (...args) => { await hold.waitHere(); return realMkdir(...args); });
    const adding = insertSeparator(accessTo(dir), 'Default', 'Armor', { kind: 'mod', name: 'Harder VATS' });
    await hold.reachedGap;

    const syncing = syncMods(accessTo(dir), 'Default', await foldersIn(dir, await listedNow()));
    hold.release();

    expect(await adding).toMatchObject({ applied: true });
    const synced = await syncing;
    expect(synced.applied && synced.dropped).not.toContain('Armor (separator)');
    expect(await readEntries()).toContainEqual({ kind: 'separator', name: 'Armor', enabled: true });
  });

  // Rival: the same, for a rename: the sync drops the renamed line, whose folder has not moved
  // yet, and gives the old folder a line of its own.
  it('keeps the line of a separator being renamed, and gives its old folder none', async () => {
    const hold = gap();
    const realRename = present(vi.mocked(rename).getMockImplementation(), 'the real rename');
    // The first rename call is the folder move; the line's own atomic write is the second.
    vi.mocked(rename).mockImplementationOnce(async (...args) => { await hold.waitHere(); return realRename(...args); });
    const renaming = renameSeparator(accessTo(dir), 'Default', 'Unassigned (Modlist Development)', 'Renamed');
    await hold.reachedGap;

    const syncing = syncMods(accessTo(dir), 'Default', await foldersIn(dir, await listedNow()));
    hold.release();

    expect(await renaming).toMatchObject({ applied: true });
    expect(await syncing).toMatchObject({ applied: true });
    const separators = (await readEntries()).filter((e) => e.kind === 'separator').map((e) => e.name);
    expect(separators).toContain('Renamed');
    expect(separators).not.toContain('Unassigned (Modlist Development)');
  });
});

// ADR-0015 invariant 1: a command never reads the Instance, the read model built only by watching.
// src/test/commandInstanceScan.test.ts scans every command box too; this is this file's own guard.
describe('modlist commands never import the Instance', () => {
  it('names no import from ../instanceLoader and no `Instance` identifier', () => {
    const path = join(__dirname, '..', 'modlist.ts');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes('instanceLoader')) {
        offenders.push(`import of "${node.moduleSpecifier.text}"`);
      }
      if (ts.isIdentifier(node) && node.text === 'Instance') {
        offenders.push('identifier `Instance`');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(offenders).toEqual([]);
  });
});
