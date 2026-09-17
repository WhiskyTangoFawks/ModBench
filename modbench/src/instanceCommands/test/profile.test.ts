import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { switchProfile } from '../profile';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';

const INI = 'ModOrganizer.ini';

// The corpus fixture's own two profile directories, as the value lists them.
const PROFILES = ['Default', 'Secondary'];

const iniText = (root: string): Promise<string> => readFile(join(root, INI), 'utf8');

describe('switchProfile', () => {
  let root: string;

  beforeEach(async () => { root = await cloneCorpusFixture(); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('repoints ModOrganizer.ini and nothing else', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfile(root, 'Secondary', PROFILES);

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await iniText(root)).toContain('Secondary');
    assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
  });

  // Rival: write unconditionally. The ModOrganizer.ini watcher would then fire on a gesture that
  // changed no byte, and `wrote` would stop meaning anything.
  it('writes nothing when the profile is already the selected one', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfile(root, 'Default', PROFILES);

    expect(outcome).toEqual({ applied: true, wrote: false });
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  // Rival: accept any name. Every later read then resolves paths under a directory that is not
  // there, which no reader can tell from a corrupt ini.
  it('refuses a name the value does not list, leaving the selection where it was', async () => {
    const before = await iniText(root);

    const outcome = await switchProfile(root, 'No Such Profile', PROFILES);

    expect(outcome).toEqual({ applied: false, refusal: 'No such profile: No Such Profile' });
    expect(await iniText(root)).toBe(before);
  });

  // Rival: probe `profiles/<name>/` instead of reading the argument. "Secondary" is a real
  // directory in the fixture, so a probe lets it through where the value's list does not.
  it('refuses on the list it is handed, never on what it finds under profiles/', async () => {
    const before = await iniText(root);

    const outcome = await switchProfile(root, 'Secondary', ['Default']);

    expect(outcome).toEqual({ applied: false, refusal: 'No such profile: Secondary' });
    expect(await iniText(root)).toBe(before);
  });

  it('refuses rather than throwing when ModOrganizer.ini cannot be read', async () => {
    await rm(join(root, INI));

    const outcome = await switchProfile(root, 'Secondary', PROFILES);

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/ENOENT/);
  });

  it('serializes concurrent switches — the last one issued is the selected one', async () => {
    const [first, second] = await Promise.all([
      switchProfile(root, 'Secondary', PROFILES),
      switchProfile(root, 'Default', PROFILES),
    ]);

    expect(first).toEqual({ applied: true, wrote: true });
    expect(second).toEqual({ applied: true, wrote: true });
    expect(await iniText(root)).toContain('Default');
  });
});
