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
  return { ...actual, readFile };
});

import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveModToSeparator,
  renameSeparator,
  reorderMod,
  adoptMods,
  reorderSeparatorBlock,
  setModEnabled,
  uninstallMod,
} from '../modlist';
import { parseModlist } from '../../mo2Codecs/modlistText';

const fixture = join(__dirname, '..', '..', 'modmanager', 'test', 'fixtures', 'mo2-instance');

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
      setModEnabled(dir, 'Default', 'Harder VATS', true),
      setModEnabled(dir, 'Default', 'ENBoost - 12k', false),
    ]);
    expect(a).toEqual({ applied: true, wrote: true });
    expect(b).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    expect(entries.find((e) => e.name === 'Harder VATS')?.enabled).toBe(true);
    expect(entries.find((e) => e.name === 'ENBoost - 12k')?.enabled).toBe(false);
  });

  it('setModEnabled flips only the target prefix on disk', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await setModEnabled(dir, 'Default', 'Harder VATS', true);
    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS', '+Harder VATS'));
  });

  it('setModEnabled to the state the mod already has writes nothing', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await setModEnabled(dir, 'Default', 'Harder VATS', false); // fixture: already disabled
    expect(outcome).toEqual({ applied: true, wrote: false });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('setModEnabled refuses an unknown mod, leaving the file untouched', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await setModEnabled(dir, 'Default', 'No Such Mod', true);
    assertRefusal(outcome, 'No Such Mod');
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('reorderMod writes the new line order', async () => {
    const outcome = await reorderMod(dir, 'Default', 'Cracked and Smudged Pip-Boy Screen', 0);
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names[0]).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  it('reorderMod refuses an unknown mod', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await reorderMod(dir, 'Default', 'No Such Mod', 0);
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

  it('moveModToSeparator moves the mod to the end of the named section', async () => {
    const outcome = await moveModToSeparator(dir, 'Default', 'SKK Fast Start new game (Fallout 4)', 'Radfall - All-In-One Survival Overhaul');
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names.indexOf('SKK Fast Start new game (Fallout 4)')).toBe(names.indexOf('Radfall - All-In-One Survival Overhaul') - 1);
  });

  it('moveModToSeparator(null) moves the mod to the ungrouped tail', async () => {
    const outcome = await moveModToSeparator(dir, 'Default', '[NODELETE] Radfall', null);
    expect(outcome).toEqual({ applied: true, wrote: true });
    const entries = await readModlist();
    expect(entries.at(-1)?.name).toBe('[NODELETE] Radfall');
  });

  it('moveModToSeparator refuses an unknown mod', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await moveModToSeparator(dir, 'Default', 'No Such Mod', null);
    assertRefusal(outcome);
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  it('reorderSeparatorBlock moves the separator and its members together', async () => {
    // toIndex counts entries with the block already removed; 2 lands it after Unofficial
    // Fallout 4 Patch — genuinely moved, not the no-op its current front position would be.
    const outcome = await reorderSeparatorBlock(dir, 'Default', 'Unassigned (Modlist Development)', 2);
    expect(outcome).toEqual({ applied: true, wrote: true });
    const names = (await readModlist()).map((e) => e.name);
    expect(names[2]).toBe('SKK Fast Start new game (Fallout 4)');
    expect(names[3]).toBe('Unassigned (Modlist Development)');
  });

  it('reorderSeparatorBlock refuses an unknown separator', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    const outcome = await reorderSeparatorBlock(dir, 'Default', 'No Such Separator', 0);
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
  });
});

describe('adoptMods — the unlisted folders it is handed get a modlist.txt line', () => {
  let dir: string;
  const modlistPath = () => join(dir, 'profiles', 'Default', 'modlist.txt');
  const readModlist = async () => parseModlist(await readFile(modlistPath(), 'utf8'));
  const adopt = (folders: string[]) => adoptMods(dir, 'Default', folders);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-adopt-'));
    await cp(fixture, dir, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('adds a disabled winning-end line for the folder it is handed, preserving every registered line', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    expect(await adopt(['Hand Extracted Mod'])).toEqual({ applied: true, added: ['Hand Extracted Mod'] });

    const entries = await readModlist();
    expect(entries.at(0)).toMatchObject({ kind: 'mod', name: 'Hand Extracted Mod', enabled: false });
    expect(await readFile(modlistPath(), 'utf8')).toContain(before.split('\r\n').slice(1).join('\r\n'));
  });

  it('writes a batch ascending top-to-bottom, winning-most first', async () => {
    expect(await adopt(['Zeta Mod', 'Alpha Mod'])).toEqual({ applied: true, added: ['Alpha Mod', 'Zeta Mod'] });
    expect((await readModlist()).slice(0, 2).map((e) => e.name)).toEqual(['Alpha Mod', 'Zeta Mod']);
  });

  // The value is a generation old by the time a write lands, so two landed values can hand the
  // same folder over twice. The line the file already carries is the one that stands.
  it('never writes a second line for a folder the file already lists', async () => {
    await adopt(['Hand Extracted Mod']);
    const afterFirst = await readFile(modlistPath(), 'utf8');

    expect(await adopt(['Hand Extracted Mod'])).toEqual({ applied: true, added: [] });
    expect(await readFile(modlistPath(), 'utf8')).toBe(afterFirst);
  });

  it('handed nothing, writes nothing at all', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    expect(await adopt([])).toEqual({ applied: true, added: [] });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  // The folders arrive from the Instance value, so the command has no reason to look at mods/
  // and must not fail when it cannot.
  it('adopts what it is handed with no mods/ directory on disk at all', async () => {
    await rm(join(dir, 'mods'), { recursive: true, force: true });

    expect(await adopt(['Hand Extracted Mod'])).toEqual({ applied: true, added: ['Hand Extracted Mod'] });
    expect((await readModlist()).map((e) => e.name)).toContain('Hand Extracted Mod');
  });

  it('refuses when modlist.txt cannot be read, rather than throwing', async () => {
    await rm(modlistPath());

    assertRefusal(await adopt(['Hand Extracted Mod']), 'ENOENT');
  });
});

// ADR-0015 invariant 1: a command never reads the Instance, the read model built only by watching.
// src/test/commandInstanceScan.test.ts scans every command box too; this is this file's own guard.
describe('modlist commands never import the Instance', () => {
  it('names no import from ../instance and no `Instance` identifier', () => {
    const path = join(__dirname, '..', 'modlist.ts');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes('instance')) {
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
