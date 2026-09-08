import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

// Delay is 0 by default (a passthrough), so only the concurrent-write test below opts in.
const fsState = vi.hoisted(() => {
  type ReadFile = typeof import('node:fs/promises')['readFile'];
  return { real: undefined as unknown as ReadFile, delayMs: 0 };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsState.real = actual.readFile;
  const readFile = vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const result = await fsState.real(...args);
    if (fsState.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fsState.delayMs));
    return result;
  });
  return { ...actual, readFile };
});

import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveModToSeparator,
  renameSeparator,
  reorderMod,
  reconcileMods,
  reorderSeparatorBlock,
  setModEnabled,
  uninstallMod,
} from './modlist';
import { parseModlist } from '../mo2/modlistText';

const fixture = join(__dirname, '..', 'test', 'fixtures', 'mo2-instance');
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

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
    expect(outcome).toEqual({ applied: false, refusal: expect.stringContaining('No Such Mod') });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
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
    expect(outcome).toEqual({ applied: false, refusal: expect.any(String) });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
    expect(await readdir(join(dir, 'mods'))).toEqual(beforeDirs);
  });

  it('uninstallMod marks the matching download uninstalled, without failing the uninstall itself', async () => {
    await uninstallMod(dir, 'Default', 'Unofficial Fallout 4 Patch');
    const meta = await readFile(
      join(dir, 'downloads', 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z.meta'), 'utf8',
    );
    expect(meta).toContain('uninstalled=true');
    expect((await readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
  });

  describe('createEmptyMod', () => {
    it('creates an empty folder under mods/ and a disabled modlist line', async () => {
      const outcome = await createEmptyMod(dir, 'Default', 'My New Mod');
      expect(outcome).toEqual({ applied: true, wrote: true });
      expect((await stat(join(dir, 'mods', 'My New Mod'))).isDirectory()).toBe(true);
      expect(await readdir(join(dir, 'mods', 'My New Mod'))).toEqual([]);
      const entries = await readModlist();
      expect(entries.find((e) => e.name === 'My New Mod')).toEqual({ kind: 'mod', name: 'My New Mod', enabled: false });
    });

    it('refuses a name that already exists, clobbering neither the folder nor the modlist', async () => {
      const beforeModlist = await readFile(modlistPath(), 'utf8');
      const before = await readdir(join(dir, 'mods', 'Harder VATS'));
      const outcome = await createEmptyMod(dir, 'Default', 'Harder VATS');
      expect(outcome).toEqual({ applied: false, refusal: expect.stringContaining('Harder VATS') });
      expect(await readdir(join(dir, 'mods', 'Harder VATS'))).toEqual(before);
      expect(await readFile(modlistPath(), 'utf8')).toBe(beforeModlist);
    });
  });
});

describe('reconcileMods — modlist.txt converges on what mods/ holds', () => {
  let dir: string;
  const modlistPath = () => join(dir, 'profiles', 'Default', 'modlist.txt');
  const readModlist = async () => parseModlist(await readFile(modlistPath(), 'utf8'));
  const reconcile = () => reconcileMods(dir, 'Default');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'modlist-reconcile-'));
    await cp(fixture, dir, { recursive: true });
    // The fixture ships one listed-but-folderless entry, which every test here would otherwise
    // prune on top of its own arranged delta.
    await mkdir(join(dir, 'mods', '[NODELETE] Radfall'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('adds a disabled winning-end entry for an untracked mods/ folder, preserving every registered line', async () => {
    await mkdir(join(dir, 'mods', 'Hand Extracted Mod'));
    const before = await readFile(modlistPath(), 'utf8');

    expect(await reconcile()).toEqual({ applied: true, added: ['Hand Extracted Mod'], pruned: [] });

    const entries = await readModlist();
    expect(entries.at(0)).toMatchObject({ kind: 'mod', name: 'Hand Extracted Mod', enabled: false });
    expect(await readFile(modlistPath(), 'utf8')).toContain(before.split('\r\n').slice(1).join('\r\n'));
  });

  it('skips the overwrite folder and separator marker folders', async () => {
    await mkdir(join(dir, 'mods', 'overwrite'));

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: [] });
  });

  it('is idempotent — a second run registers nothing new', async () => {
    await mkdir(join(dir, 'mods', 'Hand Extracted Mod'));
    await reconcile();

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: [] });
  });

  it('registers multiple new folders in sorted order top-to-bottom (winning-most first)', async () => {
    await mkdir(join(dir, 'mods', 'Zeta Mod'));
    await mkdir(join(dir, 'mods', 'Alpha Mod'));

    expect(await reconcile()).toEqual({ applied: true, added: ['Alpha Mod', 'Zeta Mod'], pruned: [] });
    expect((await readModlist()).slice(0, 2).map((e) => e.name)).toEqual(['Alpha Mod', 'Zeta Mod']);
  });

  it('ignores a stray file directly in mods/, not just directories', async () => {
    await writeFile(join(dir, 'mods', 'Thumbs.db'), '');

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: [] });
  });

  it('prunes the entry of a mod whose folder was deleted, byte-faithfully', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    await rm(join(dir, 'mods', 'Harder VATS'), { recursive: true, force: true });

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: ['Harder VATS'] });

    // Exactly that one line gone; every other byte identical.
    expect(await readFile(modlistPath(), 'utf8')).toBe(before.replace('-Harder VATS\r\n', ''));
  });

  it('writes nothing when every entry still has its folder and every folder a line', async () => {
    const before = await readFile(modlistPath(), 'utf8');

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: [] });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  // A dead separator is not a dead mod: prune is scoped to mods, so deleting a separator's
  // marker folder must not remove the separator entry.
  it('never prunes a separator entry, whose folder is the _separator marker', async () => {
    await rm(join(dir, 'mods', 'Unassigned (Modlist Development)_separator'), { recursive: true, force: true });

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: [] });
    expect(await readFile(modlistPath(), 'utf8')).toContain('Unassigned (Modlist Development)_separator');
  });

  // Only a listing that actually answered can say a folder is gone: a missing mods/ must not
  // read as a mass delete.
  it('reconciles nothing when mods/ itself is missing — a malformed workspace', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    await rm(join(dir, 'mods'), { recursive: true, force: true });

    expect(await reconcile()).toEqual({ applied: true, added: [], pruned: [] });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });

  // Only ENOENT means "no mods/ yet"; any other listing failure is a real one.
  it('refuses when mods/ exists but is not a directory — not silently "nothing to do"', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    await rm(join(dir, 'mods'), { recursive: true, force: true });
    await writeFile(join(dir, 'mods'), 'not a directory');

    expect(await reconcile()).toEqual({ applied: false, refusal: expect.any(String) });
    expect(await readFile(modlistPath(), 'utf8')).toBe(before);
  });
});

// ADR-0047 point 6: a command never reads the Instance, the read model built only by watching.
// commands/instanceScan.test.ts glob-scans this whole folder too; this is this file's own guard.
describe('modlist commands never import the Instance', () => {
  it('names no import from ../instance and no `Instance` identifier', () => {
    const path = join(__dirname, 'modlist.ts');
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
