import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { instanceCommands } from '../instanceCommands';
import { fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';

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
