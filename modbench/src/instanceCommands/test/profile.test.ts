import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { instanceCommands } from '../instanceCommands';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import { fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';

const PROFILES = ['Default', 'Secondary'];

const switchProfileOver = (adapter: InstanceAdapter) =>
  instanceCommands({ adapter, client: new InMemoryMEditClient(), instanceRoot: '/instance' }).switchProfile;

describe('switchProfile', () => {
  const over = (answers: InstanceAnswers = {}) => {
    const fake = fakeInstanceAdapter(readingFixture(), answers);
    return { fake, switchProfile: switchProfileOver(fake.adapter) };
  };

  it('hands the adapter the profile and reports whether it wrote', async () => {
    const { fake, switchProfile } = over();

    expect(await switchProfile('Secondary', PROFILES)).toEqual({ applied: true, wrote: true });
    expect(fake.calls).toEqual([{ verb: 'selectProfile', profile: 'Secondary' }]);
  });

  it.each([
    ['a name the value does not list', 'No Such Profile', PROFILES],
    ['a name absent from the list it is handed, whatever profiles the instance holds', 'Secondary', ['Default']],
  ])('refuses %s, handing the adapter nothing', async (_, profile, listed) => {
    const { fake, switchProfile } = over();

    expect(await switchProfile(profile, listed)).toEqual({ applied: false, refusal: `No such profile: ${profile}` });
    expect(fake.calls).toEqual([]);
  });

  it('refuses rather than throwing when the adapter cannot select', async () => {
    const { switchProfile } = over({ refusals: refusing('selectProfile', 'ENOENT: no ModOrganizer.ini') });

    expect(await switchProfile('Secondary', PROFILES)).toEqual({ applied: false, refusal: expect.stringMatching(/ENOENT/) as unknown });
  });
});

describe('switchProfile over the committed corpus fixture: the one path from the command through the real adapter to disk', () => {
  let root: string;

  beforeEach(() => { root = cloneCorpusFixture(); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('repoints ModOrganizer.ini and nothing else', async () => {
    const before = await snapshotTree(root);

    const outcome = await switchProfileOver(adapterOver(root))('Secondary', PROFILES);

    expect(outcome).toEqual({ applied: true, wrote: true });
    assertOnlyChanged(before, await snapshotTree(root), new Set(['ModOrganizer.ini']));
  });
});
