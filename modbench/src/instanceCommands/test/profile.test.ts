import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { instanceCommands } from '../instanceCommands';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';

const INI = 'ModOrganizer.ini';

const CORPUS_FIXTURE_PROFILE_DIRECTORIES = ['Default', 'Secondary'];

const switchProfileOver = (root: string) =>
  instanceCommands({ adapter: adapterOver(root), client: new InMemoryMEditClient(), instanceRoot: root }).switchProfile;

const iniText = (root: string): Promise<string> => readFile(join(root, INI), 'utf8');

describe('switchProfile', () => {
  let root: string;

  beforeEach(() => { root = cloneCorpusFixture(); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('repoints ModOrganizer.ini and nothing else', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfileOver(root)('Secondary', CORPUS_FIXTURE_PROFILE_DIRECTORIES);

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await iniText(root)).toContain('Secondary');
    assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
  });

  it('writes nothing when the profile is already the selected one, so the ModOrganizer.ini watcher does not fire on a gesture that changed no byte', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfileOver(root)('Default', CORPUS_FIXTURE_PROFILE_DIRECTORIES);

    expect(outcome).toEqual({ applied: true, wrote: false });
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  it('refuses a name the value does not list, leaving the selection where it was, as a later read under a missing directory looks like a corrupt ini', async () => {
    const before = await iniText(root);

    const outcome = await switchProfileOver(root)('No Such Profile', CORPUS_FIXTURE_PROFILE_DIRECTORIES);

    expect(outcome).toEqual({ applied: false, refusal: 'No such profile: No Such Profile' });
    expect(await iniText(root)).toBe(before);
  });

  it('refuses on the list it is handed, never on what it finds under profiles/, where "Secondary" is a real directory in the fixture', async () => {
    const before = await iniText(root);

    const outcome = await switchProfileOver(root)('Secondary', ['Default']);

    expect(outcome).toEqual({ applied: false, refusal: 'No such profile: Secondary' });
    expect(await iniText(root)).toBe(before);
  });

  it('refuses rather than throwing when ModOrganizer.ini cannot be read', async () => {
    await rm(join(root, INI));

    const outcome = await switchProfileOver(root)('Secondary', CORPUS_FIXTURE_PROFILE_DIRECTORIES);

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/ENOENT/);
  });

  it('serializes concurrent switches — the last one issued is the selected one', async () => {
    const [first, second] = await Promise.all([
      switchProfileOver(root)('Secondary', CORPUS_FIXTURE_PROFILE_DIRECTORIES),
      switchProfileOver(root)('Default', CORPUS_FIXTURE_PROFILE_DIRECTORIES),
    ]);

    expect(first).toEqual({ applied: true, wrote: true });
    expect(second).toEqual({ applied: true, wrote: true });
    expect(await iniText(root)).toContain('Default');
  });
});
