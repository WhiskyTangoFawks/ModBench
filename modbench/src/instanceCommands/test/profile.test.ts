import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { instanceCommands } from '../instanceCommands';
import { fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { heldTexts } from '../../symbolNames/symbolNames';

const PROFILES = ['Default', 'Secondary'];

const switchProfileOver = (adapter: InstanceAdapter) =>
  instanceCommands({ adapter, client: new InMemoryMEditClient(), instanceRoot: '/instance' }).switchProfile;

describe('switchProfile', () => {
  const over = (answers: InstanceAnswers = {}) => {
    const fake = fakeInstanceAdapter(readingFixture({ profiles: [...PROFILES] }), answers);
    return { fake, switchProfile: switchProfileOver(fake.adapter) };
  };

  it('hands the adapter the profile', async () => {
    const { fake, switchProfile } = over();

    expect(await switchProfile('Secondary')).toMatchObject({ applied: true });
    expect(fake.calls).toEqual([{ verb: 'selectProfile', profile: 'Secondary' }]);
  });

  it('refuses a name the instance does not hold, handing the adapter nothing', async () => {
    const profile = 'No Such Profile';
    const { fake, switchProfile } = over();

    expect(await switchProfile(profile)).toEqual({ applied: false, refusal: `No such profile: ${profile}` });
    expect(fake.calls).toEqual([]);
  });

  it('refuses rather than throwing when the adapter cannot select', async () => {
    const { switchProfile } = over({ refusals: refusing('selectProfile', 'ENOENT: no ModOrganizer.ini') });

    expect(await switchProfile('Secondary')).toEqual({ applied: false, refusal: expect.stringMatching(/ENOENT/) as unknown });
  });

  it('refuses rather than throwing when the profiles cannot be read, handing the adapter nothing', async () => {
    const { fake, switchProfile } = over({ unreadReads: { profiles: 'profiles/ is unreadable' } });

    expect(await switchProfile('Secondary')).toEqual({ applied: false, refusal: expect.stringMatching(/unreadable/) as unknown });
    expect(fake.calls).toEqual([]);
  });
});

describe('renaming a profile another program renames (symbols.md, The features, story 6)', () => {
  const renamer = (answers: InstanceAnswers = {}) => {
    const fake = fakeInstanceAdapter(readingFixture({ profiles: [...PROFILES] }), answers);
    const editing = { held: heldTexts([]), apply: () => Promise.resolve(undefined) };
    return { fake, rename: () => instanceCommands({ adapter: fake.adapter, client: new InMemoryMEditClient(), instanceRoot: '/instance' }).renameProfile(editing, 'Secondary', 'Third') };
  };

  it('renames it, and each reference to it, through the adapter', async () => {
    const { fake, rename } = renamer();

    expect(await rename()).toEqual({ applied: true, cannotFollow: [] });
    expect(fake.calls).toEqual([{ verb: 'renameProfile', from: 'Secondary', to: 'Third' }]);
  });

  it('fails when the adapter cannot move its folder', async () => {
    const { rename } = renamer({ refusals: refusing('renameProfile', 'No profile "Secondary"') });

    expect(await rename()).toEqual({ applied: false, failed: 'No profile "Secondary"', edited: false, moved: [] });
  });
});
