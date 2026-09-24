import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { present } from '../../ports/present';

// Delay is 0 by default (a passthrough), so only the concurrent-write test below opts in.
const fsState = vi.hoisted(() => {
  type ReadFile = typeof import('node:fs/promises')['readFile'];
  const state: { real: ReadFile | undefined; delayMs: number } = { real: undefined, delayMs: 0 };
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
  return { ...actual, readFile, writeFile, mkdir };
});

import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveMods,
  moveSeparators,
  renameSeparator,
  reorderMod,
  reorderSeparatorBlock,
  setModsEnabled,
  syncMods,
  uninstallMod,
} from '../modlist';
import { insertModAtWinningEnd, parseModlist } from '../../mo2Codecs/modlistText';
import { modsDir } from '../../instanceAdapter/layout';
import { modNameCollisionRefusal } from '../../install/install';

const fixture = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance');

// The fixture's own mods/ folders, as the value lists them for the new-empty-mod refusal.
const MOD_FOLDERS = [
  'Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k', 'Harder VATS',
  'SKK Fast Start new game (Fallout 4)', 'Unassigned (Modlist Development)_separator',
  'Unofficial Fallout 4 Patch',
];
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

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
  const readModlist = async () => parseModlist(await readFile(modlistPath(), 'utf8'));
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
      setModsEnabled(dir, 'Default', ['Harder VATS'], true),
      setModsEnabled(dir, 'Default', ['ENBoost - 12k'], false),
    ]);
    expect(a).toEqual({ applied: true, outcome: { landed: ['Harder VATS'], refused: [] } });
    expect(b).toEqual({ applied: true, outcome: { landed: ['ENBoost - 12k'], refused: [] } });
    const entries = await readModlist();
    expect(entries.find((e) => e.name === 'Harder VATS')?.enabled).toBe(true);
    expect(entries.find((e) => e.name === 'ENBoost - 12k')?.enabled).toBe(false);
  });

  it('setModsEnabled flips only the mods not already in the chosen state, in one write', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    vi.mocked(writeFile).mockClear();

    const outcome = await setModsEnabled(dir, 'Default', ['Harder VATS', 'ENBoost - 12k'], true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Harder VATS', 'ENBoost - 12k'], refused: [] } });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
    expect(vi.mocked(writeFile).mock.calls.filter(([p]) => p === modlistPath())).toHaveLength(1);
  });

  it('setModsEnabled to a selection already in the chosen state writes nothing', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await setModsEnabled(
      dir, 'Default', ['ENBoost - 12k', 'SKK Fast Start new game (Fallout 4)'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['ENBoost - 12k', 'SKK Fast Start new game (Fallout 4)'], refused: [] },
    });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('setModsEnabled refuses a gone mod by name while the rest land, in one write', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    vi.mocked(writeFile).mockClear();

    const outcome = await setModsEnabled(dir, 'Default', ['Harder VATS', 'No Such Mod'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: ['Harder VATS'],
        refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }],
      },
    });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
    expect(vi.mocked(writeFile).mock.calls.filter(([p]) => p === modlistPath())).toHaveLength(1);
  });

  // Rival: a splice per mod, each catching its own read failure into a per-item refusal, which
  // answers applied:true with one reason repeated per mod.
  it('refuses the whole selection once, before any write, when modlist.txt cannot be read', async () => {
    await rm(modlistPath());

    const outcome = await setModsEnabled(dir, 'Default', ['Harder VATS', 'ENBoost - 12k'], true);

    assertRefusal(outcome, 'ENOENT');
    await expect(stat(modlistPath())).rejects.toThrow();
  });

  it('reorderMod writes the new line order', async () => {
    const outcome = await reorderMod(dir, 'Default', 'Cracked and Smudged Pip-Boy Screen', { kind: 'winningEnd' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names[0]).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  // The two sides must land one slot apart, or a tree running losing-at-top puts every drop one
  // row off from where the user let go.
  it('reorderMod settles a drop before its target', async () => {
    const outcome = await reorderMod(
      dir, 'Default', 'Cracked and Smudged Pip-Boy Screen', { kind: 'before', name: 'Unofficial Fallout 4 Patch' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names.slice(2, 5)).toEqual([
      '[NODELETE] Radfall', 'Cracked and Smudged Pip-Boy Screen', 'Unofficial Fallout 4 Patch',
    ]);
  });

  it('reorderMod settles a drop after its target, one slot further on', async () => {
    const outcome = await reorderMod(
      dir, 'Default', 'Cracked and Smudged Pip-Boy Screen', { kind: 'after', name: 'Unofficial Fallout 4 Patch' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names.slice(2, 5)).toEqual([
      '[NODELETE] Radfall', 'Unofficial Fallout 4 Patch', 'Cracked and Smudged Pip-Boy Screen',
    ]);
  });

  it('reorderMod refuses an unknown mod', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await reorderMod(dir, 'Default', 'No Such Mod', { kind: 'winningEnd' });
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('insertSeparator writes a new enabled separator line after the named entry', async () => {
    const outcome = await insertSeparator(dir, 'Default', 'New Section', 'ENBoost - 12k');
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    const idx = entries.findIndex((e) => e.name === 'ENBoost - 12k');
    expect(entries[idx + 1]).toEqual({ kind: 'separator', name: 'New Section', enabled: true });
  });

  it('insertSeparator on a mod inside a separator splits it: the mods on the anchor\'s winning side join the new one', async () => {
    const outcome = await insertSeparator(dir, 'Default', 'New Section', '[NODELETE] Radfall');
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
    const outcome = await insertSeparator(dir, 'Default', 'New Section', 'Harder VATS');
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
    const outcome = await insertSeparator(dir, 'Default', 'New Section', 'Radfall - All-In-One Survival Overhaul');
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
    const outcome = await insertSeparator(dir, 'Default', 'New Section', 'Unassigned (Modlist Development)');
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

    const outcome = await insertSeparator(dir, 'Default', 'New Section', 'SecondGroup');

    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toEqual(['FirstGroup', 'New Section', 'SecondGroup', 'SKK Fast Start new game (Fallout 4)']);
  });

  it('insertSeparator refuses when the anchor entry is absent', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await insertSeparator(dir, 'Default', 'New Section', 'No Such Entry');
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('renameSeparator rewrites the separator line in place', async () => {
    const outcome = await renameSeparator(dir, 'Default', 'Unassigned (Modlist Development)', 'Renamed');
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    expect(entries.some((e) => e.name === 'Renamed' && e.kind === 'separator')).toBe(true);
    expect(entries.some((e) => e.name === 'Unassigned (Modlist Development)')).toBe(false);
  });

  it('renameSeparator refuses an unknown separator', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await renameSeparator(dir, 'Default', 'No Such Separator', 'Renamed');
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('deleteSeparator removes only the separator line, keeping its mods', async () => {
    const outcome = await deleteSeparator(dir, 'Default', 'Radfall - All-In-One Survival Overhaul');
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    expect(entries.some((e) => e.name === 'Radfall - All-In-One Survival Overhaul')).toBe(false);
    expect(entries.some((e) => e.name === 'ENBoost - 12k')).toBe(true);
  });

  it('deleteSeparator refuses an unknown separator', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await deleteSeparator(dir, 'Default', 'No Such Separator');
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('moveMods at the losing end makes the mods the chosen separator\'s losing-most mods, keeping their order among themselves', async () => {
    const outcome = await moveMods(
      dir, 'Default', ['Cracked and Smudged Pip-Boy Screen', 'ENBoost - 12k'],
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
    const outcome = await moveMods(
      dir, 'Default', ['Unofficial Fallout 4 Patch', 'SKK Fast Start new game (Fallout 4)'], { kind: 'ungrouped' }, 'losing');

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
    const outcome = await moveMods(
      dir, 'Default', ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'],
      { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing');

    expect(outcome).toEqual({
      applied: true, outcome: { landed: ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'], refused: [] },
    });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('moveMods refuses a gone mod by name while the others land, in one write', async () => {
    vi.mocked(writeFile).mockClear();

    const outcome = await moveMods(
      dir, 'Default', ['No Such Mod', 'Harder VATS'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    const names = (await readModlist()).map((e) => e.name);
    expect(names.slice(0, 3)).toEqual([
      'SKK Fast Start new game (Fallout 4)', 'Harder VATS', 'Unassigned (Modlist Development)',
    ]);
    expect(vi.mocked(writeFile).mock.calls.filter(([p]) => p === modlistPath())).toHaveLength(1);
  });

  it('moveMods to a separator that has gone refuses the whole move, naming it', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    const outcome = await moveMods(dir, 'Default', ['Harder VATS'], { kind: 'separator', name: 'Gone Separator' }, 'losing');

    assertRefusal(outcome, 'Gone Separator');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('moveMods refuses the whole selection once when modlist.txt cannot be read', async () => {
    await rm(modlistPath());

    const outcome = await moveMods(dir, 'Default', ['Harder VATS', 'ENBoost - 12k'], { kind: 'ungrouped' }, 'losing');

    assertRefusal(outcome, 'ENOENT');
    await expect(stat(modlistPath())).rejects.toThrow();
  });

  it('moveSeparators on the losing side lands each separator with its mods directly on the losing side of the chosen one', async () => {
    const outcome = await moveSeparators(
      dir, 'Default', ['Unassigned (Modlist Development)'], 'Radfall - All-In-One Survival Overhaul', 'losing');

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
    const outcome = await moveSeparators(
      dir, 'Default', ['Radfall - All-In-One Survival Overhaul'], 'Unassigned (Modlist Development)', 'losing');

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Radfall - All-In-One Survival Overhaul'], refused: [] } });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('moveSeparators refuses a gone separator by name while the others land', async () => {
    const outcome = await moveSeparators(
      dir, 'Default', ['Gone Separator', 'Unassigned (Modlist Development)'], 'Radfall - All-In-One Survival Overhaul', 'losing');

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

    const outcome = await moveSeparators(dir, 'Default', ['Unassigned (Modlist Development)'], 'Gone Separator', 'losing');

    assertRefusal(outcome, 'Gone Separator');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('reorderSeparatorBlock moves the separator and its members together', async () => {
    // Dropped onto the next separator — genuinely moved, not the no-op its current front
    // position would be.
    const outcome = await reorderSeparatorBlock(
      dir, 'Default', 'Unassigned (Modlist Development)',
      { kind: 'before', name: 'Radfall - All-In-One Survival Overhaul' });
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names[2]).toBe('SKK Fast Start new game (Fallout 4)');
    expect(names[3]).toBe('Unassigned (Modlist Development)');
  });

  it('reorderSeparatorBlock refuses an unknown separator', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await reorderSeparatorBlock(dir, 'Default', 'No Such Separator', { kind: 'winningEnd' });
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('uninstallMod removes the modlist entry and deletes the mod folder', async () => {
    const outcome = await uninstallMod(dir, 'Default', 'Harder VATS');
    expect(outcome).toEqual({ applied: true, wrote: true });
    expect((await readModlist()).some((e) => e.name === 'Harder VATS')).toBe(false);
    await expect(stat(join(dir, 'mods', 'Harder VATS'))).rejects.toThrow();
  });

  it('uninstallMod refuses an unknown mod, leaving the modlist and mods/ untouched', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const beforeDirs = await readdir(join(dir, 'mods'));
    const outcome = await uninstallMod(dir, 'Default', 'No Such Mod');
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await readdir(join(dir, 'mods'))).toEqual(beforeDirs);
  });

  it('uninstallMod marks the download it is handed uninstalled, without failing the uninstall itself', async () => {
    await uninstallMod(
      dir, 'Default', 'Unofficial Fallout 4 Patch', 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z');
    const meta = await readFile(
      join(dir, 'downloads', 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z.meta'), 'utf8',
    );
    expect(meta).toContain('uninstalled=true');
    expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
  });

  // A mod outlives the download it came from, so an uninstall can name an archive that is gone,
  // and a sidecar beside no archive is a file MO2 would never write.
  it('uninstallMod writes no sidecar for an archive that is absent from downloads/', async () => {
    const outcome = await uninstallMod(dir, 'Default', 'Harder VATS', 'Long Gone-1-0.7z');

    expect(outcome).toEqual({ applied: true, wrote: true });
    await expect(stat(join(dir, 'downloads', 'Long Gone-1-0.7z.meta'))).rejects.toThrow();
  });

  describe('createEmptyMod', () => {
    it('creates an empty folder under mods/ and a disabled modlist line', async () => {
      const outcome = await createEmptyMod(dir, 'Default', 'My New Mod', MOD_FOLDERS);
      expect(outcome).toEqual({ applied: true, wrote: true });
      expect((await stat(join(dir, 'mods', 'My New Mod'))).isDirectory()).toBe(true);
      expect(await readdir(join(dir, 'mods', 'My New Mod'))).toEqual([]);
      const entries = await readModlist();
      expect(entries.find((e) => e.name === 'My New Mod')).toEqual({ kind: 'mod', name: 'My New Mod', enabled: false });
    });

    // insertModAtWinningEnd always lands above whatever is currently first, so the new line is
    // entries[0] deterministically — the fixture's own winning-most mod moves to entries[1].
    it('lands the line at the winning end, disabled, exactly once, with the folder on disk', async () => {
      const outcome = await createEmptyMod(dir, 'Default', 'Winning End Mod', MOD_FOLDERS);

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

      await expect(createEmptyMod(dir, 'Default', 'Folder Write Fails', MOD_FOLDERS)).rejects.toThrow(/permission denied/);

      expect(await readFile(modlistPath(), 'utf8')).toBe(beforeModlist);
    });

    // Rival: probe `mods/<name>/` instead of reading the argument. The folder below is on disk
    // with no line of its own, so a probe refuses where the argument lets it through.
    it('refuses only on the folders it is handed, never on what it finds under mods/', async () => {
      await mkdir(join(dir, 'mods', 'Dropped In Behind Modbench'));

      const outcome = await createEmptyMod(dir, 'Default', 'Dropped In Behind Modbench', ['Something Else']);

      expect(outcome).toEqual({ applied: true, wrote: true });
      expect((await readModlist()).some((e) => e.name === 'Dropped In Behind Modbench')).toBe(true);
    });

    // Rival: refuse only what the modlist lists. A folder MO2 dropped in with no line would
    // then be clobbered by a new empty mod of the same name.
    it('refuses a name the value already lists as a folder, clobbering neither it nor the modlist', async () => {
      const beforeModlist = await readFile(modlistPath(), 'utf8');
      const before = await readdir(join(dir, 'mods', 'Harder VATS'));
      const outcome = await createEmptyMod(dir, 'Default', 'Harder VATS', MOD_FOLDERS);
      assertRefusal(outcome, 'Harder VATS');
      expect(await readdir(join(dir, 'mods', 'Harder VATS'))).toEqual(before);
      expect(await readFile(modlistPath(), 'utf8')).toBe(beforeModlist);
    });

    // On disk and in modFolders, but with no modlist.txt line — mod sync has not caught up yet.
    // Rival: the old ad hoc text, which read differently from install's own refusal.
    it('refuses a lineless folder in the words install gives the same collision', async () => {
      await mkdir(join(dir, 'mods', 'Lineless Folder'));

      const outcome = await createEmptyMod(dir, 'Default', 'Lineless Folder', [...MOD_FOLDERS, 'Lineless Folder']);

      expect(outcome).toEqual({ applied: false, refusal: modNameCollisionRefusal('Lineless Folder') });
    });

    // Models mod sync winning the race against this command's own line write.
    // Rival: insert unconditionally. That doubles the line here.
    it('writes no second line when mod sync already added it, and reports no failure', async () => {
      const name = 'Synced In First';
      const before = await readFile(modlistPath(), 'utf8');
      await writeFile(modlistPath(), insertModAtWinningEnd(before, name));

      const outcome = await createEmptyMod(dir, 'Default', name, MOD_FOLDERS);

      expect(outcome).toEqual({ applied: true, wrote: false });
      expect((await stat(join(dir, 'mods', name))).isDirectory()).toBe(true);
      expect((await readModlist()).filter((e) => e.name === name)).toHaveLength(1);
    });

    // Rival: fold the line's failure back into `applied: false`. The folder is on disk either
    // way, so that reports a landed create as failed.
    it('a failed line write leaves the folder in place and answers a partial, not a refusal', async () => {
      const name = 'Line Write Fails';
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      const outcome = await createEmptyMod(dir, 'Default', name, MOD_FOLDERS);

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
  const readModlist = async () => parseModlist(await readFile(modlistPath(), 'utf8'));
  const writesToModlist = () => vi.mocked(writeFile).mock.calls.filter(([path]) => path === modlistPath()).length;
  const sync = (folders: readonly string[]) => syncMods(dir, 'Default', folders);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-sync-'));
    await cp(fixture, dir, { recursive: true });
    vi.mocked(writeFile).mockClear();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // The fixture lists "[NODELETE] Radfall", whose folder is not among MOD_FOLDERS.
  // Rival: two splices, one per direction, which writes the file twice.
  it('adds a line for a folder with none and drops a line whose folder is gone, in one write', async () => {
    const outcome = await sync([...MOD_FOLDERS, 'Hand Extracted Mod']);

    expect(outcome).toEqual({ applied: true, added: ['Hand Extracted Mod'], dropped: ['[NODELETE] Radfall'] });
    const names = (await readModlist()).map((e) => e.name);
    expect(names).toContain('Hand Extracted Mod');
    expect(names).not.toContain('[NODELETE] Radfall');
    expect(writesToModlist()).toBe(1);
  });

  // Rival: a splice that always puts the bytes back, which fires the watcher and loops forever.
  it('writes nothing when every folder has a line and every mod line has a folder', async () => {
    await sync([...MOD_FOLDERS, '[NODELETE] Radfall']);
    vi.mocked(writeFile).mockClear();

    expect(await sync([...MOD_FOLDERS, '[NODELETE] Radfall'])).toEqual({ applied: true, added: [], dropped: [] });
    expect(writesToModlist()).toBe(0);
  });

  // The fixture's "Radfall - All-In-One Survival Overhaul" separator has no folder, and its
  // `*DLC: Automatron` line names none. Rival: dropping every line with no folder, not only a mod's.
  it('drops only mod lines: every other line stays, a separator and an unmanaged line included', async () => {
    const before = (await readFile(modlistPath(), 'utf8')).split('\r\n');

    expect(await sync(MOD_FOLDERS)).toMatchObject({ applied: true, dropped: ['[NODELETE] Radfall'] });

    const after = (await readFile(modlistPath(), 'utf8')).split('\r\n');
    expect(before.filter((line) => !after.includes(line))).toEqual(['+[NODELETE] Radfall']);
  });

  it('writes a batch of added lines ascending top-to-bottom, winning-most first', async () => {
    const outcome = await sync([...MOD_FOLDERS, 'Zeta Mod', 'Alpha Mod']);

    expect(outcome).toMatchObject({ applied: true, added: ['Alpha Mod', 'Zeta Mod'] });
    expect((await readModlist()).slice(0, 2)).toEqual([
      { kind: 'mod', name: 'Alpha Mod', enabled: false },
      { kind: 'mod', name: 'Zeta Mod', enabled: false },
    ]);
  });

  // The folders arrive from the Instance value, so the command never looks at mods/ itself.
  it('syncs against the folders it is handed with no mods/ directory on disk at all', async () => {
    await rm(join(dir, 'mods'), { recursive: true, force: true });

    expect(await sync([...MOD_FOLDERS, 'Hand Extracted Mod'])).toMatchObject({ applied: true, added: ['Hand Extracted Mod'] });
  });

  it('refuses when modlist.txt cannot be read, rather than throwing', async () => {
    await rm(modlistPath());

    assertRefusal(await sync(MOD_FOLDERS), 'ENOENT');
  });

  // A mods/ that is not there cannot be listed, so which folders are gone is unknown.
  // Rival: reading its absence as no folders, which drops every mod line in one write.
  it('refuses, naming the folder, and writes nothing when there is no mods/ to list', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    assertRefusal(await syncMods(dir, 'Default', undefined), modsDir(dir));
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(writesToModlist()).toBe(0);
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
