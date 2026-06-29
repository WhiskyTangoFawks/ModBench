import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mo2ModlistSource } from './Mo2ModlistSource';
import type { Mod } from '../model';

const fixture = join(__dirname, '..', 'test', 'fixtures', 'mo2-instance');

describe('Mo2ModlistSource — reads (against the committed fixture)', () => {
  const src = new Mo2ModlistSource(fixture);

  it('reads the active profile modlist in priority order with meta.ini joined', async () => {
    const entries = await src.readModlist();
    expect(entries.map((e) => e.name)).toEqual([
      'SKK Fast Start new game (Fallout 4)',
      'Unassigned (Modlist Development)',
      '[NODELETE] Radfall',
      'Unofficial Fallout 4 Patch',
      'Radfall - All-In-One Survival Overhaul',
      'ENBoost - 12k',
      'Harder VATS',
      'Cracked and Smudged Pip-Boy Screen',
    ]);

    const ufo4p = entries.find((e) => e.name === 'Unofficial Fallout 4 Patch') as Mod;
    expect(ufo4p).toMatchObject({
      kind: 'mod',
      enabled: true,
      version: '2.1.5.0',
      nexusId: '4598',
      archiveFilename: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
  });

  it('leaves metadata undefined for a mod whose meta.ini is empty-valued or absent', async () => {
    const entries = await src.readModlist();
    const enboost = entries.find((e) => e.name === 'ENBoost - 12k') as Mod;
    const radfall = entries.find((e) => e.name === '[NODELETE] Radfall') as Mod; // no meta.ini on disk
    for (const m of [enboost, radfall]) {
      expect(m.version).toBeUndefined();
      expect(m.nexusId).toBeUndefined();
      expect(m.archiveFilename).toBeUndefined();
    }
  });

  it('reports the active profile and enumerates profiles', async () => {
    expect(await src.getActiveProfile()).toBe('Default');
    expect((await src.listProfiles()).sort((a, b) => a.localeCompare(b))).toEqual(['Default', 'Secondary']);
  });

  it('reads plugins.txt order (read-only), stripping markers and comments', async () => {
    expect(await src.readPluginOrder()).toEqual([
      'Unofficial Fallout 4 Patch.esp',
      'ccSBJFO4003-Grenade.esl',
    ]);
  });
});

describe('Mo2ModlistSource — writes (against a tmp copy)', () => {
  let dir: string;
  let src: Mo2ModlistSource;
  const modlistPath = () => join(dir, 'profiles', 'Default', 'modlist.txt');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mo2-'));
    await cp(fixture, dir, { recursive: true });
    src = new Mo2ModlistSource(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('setEnabled flips only the target prefix on disk, preserving all other bytes', async () => {
    const before = await readFile(modlistPath(), 'utf8');
    await src.setEnabled('Harder VATS', true);
    const after = await readFile(modlistPath(), 'utf8');
    expect(after).toBe(before.replace('-Harder VATS', '+Harder VATS'));
  });

  it('reorder writes the new line order', async () => {
    await src.reorder('Cracked and Smudged Pip-Boy Screen', 0);
    const entries = await src.readModlist();
    expect(entries[0].name).toBe('Cracked and Smudged Pip-Boy Screen');
  });

  it('readPluginOrder tolerates a BOM and blank/whitespace lines', async () => {
    const path = join(dir, 'profiles', 'Default', 'plugins.txt');
    await writeFile(path, '﻿# header\r\n*Foo.esp\r\n\r\n   \r\nBar.esp\r\n');
    expect(await src.readPluginOrder()).toEqual(['Foo.esp', 'Bar.esp']);
  });

  it('setActiveProfile persists selected_profile and switches which modlist is read', async () => {
    await src.setActiveProfile('Secondary');
    expect(await src.getActiveProfile()).toBe('Secondary');
    const ini = await readFile(join(dir, 'ModOrganizer.ini'), 'utf8');
    expect(ini).toContain('selected_profile=@ByteArray(Secondary)');
    // now reads the Secondary profile's smaller modlist
    expect((await src.readModlist()).map((e) => e.name)).toEqual([
      'Unofficial Fallout 4 Patch',
      'Harder VATS',
    ]);
  });
});
