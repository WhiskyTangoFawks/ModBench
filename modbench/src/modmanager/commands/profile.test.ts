import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listProfiles, switchProfile } from './profile';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../test/corpusFixture';

const INI = 'ModOrganizer.ini';

const iniText = (root: string): Promise<string> => readFile(join(root, INI), 'utf8');

describe('switchProfile', () => {
  let root: string;

  beforeEach(async () => { root = await cloneCorpusFixture(); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('repoints ModOrganizer.ini and nothing else', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfile(root, 'Secondary');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await iniText(root)).toContain('Secondary');
    assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
  });

  // Rival: write unconditionally. The ModOrganizer.ini watcher would then fire on a gesture that
  // changed no byte, and `wrote` would stop meaning anything.
  it('writes nothing when the profile is already the selected one', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfile(root, 'Default');

    expect(outcome).toEqual({ applied: true, wrote: false });
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  // Rival: accept any name. Every later read then resolves paths under a directory that is not
  // there, which no reader can tell from a corrupt ini.
  it('refuses a profile with no directory, leaving the selection where it was', async () => {
    const before = await iniText(root);

    const outcome = await switchProfile(root, 'No Such Profile');

    expect(outcome).toEqual({ applied: false, refusal: 'No such profile: No Such Profile' });
    expect(await iniText(root)).toBe(before);
  });

  it('refuses rather than throwing when ModOrganizer.ini cannot be read', async () => {
    await rm(join(root, INI));

    const outcome = await switchProfile(root, 'Secondary');

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/ENOENT/);
  });

  it('serializes concurrent switches — the last one issued is the selected one', async () => {
    const [first, second] = await Promise.all([
      switchProfile(root, 'Secondary'),
      switchProfile(root, 'Default'),
    ]);

    expect(first).toEqual({ applied: true, wrote: true });
    expect(second).toEqual({ applied: true, wrote: true });
    expect(await iniText(root)).toContain('Default');
  });
});

describe('listProfiles', () => {
  let root: string;

  beforeEach(async () => { root = await cloneCorpusFixture(); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names every profile directory', async () => {
    expect((await listProfiles(root)).sort()).toEqual(['Default', 'Secondary']);
  });

  // Rival: a listing that maps the dirents straight through — MO2 keeps loose files under
  // profiles/, and one offered as a profile is a switch onto files that do not exist.
  it('ignores a stray file directly in profiles/', async () => {
    await writeFile(join(root, 'profiles', 'stray.txt'), 'not a profile');

    expect((await listProfiles(root)).sort()).toEqual(['Default', 'Secondary']);
  });
});
