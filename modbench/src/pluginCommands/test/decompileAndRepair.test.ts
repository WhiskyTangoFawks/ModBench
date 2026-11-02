import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture, repositoriesOf } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { MEditClient } from '../../client';

const MALFORMED = { name: 'Malformed.esp', origin: 'Harbor' };
const REFUSED = { item: { name: 'Clean.esp', origin: 'Harbor' }, reason: 'Clean.esp is not malformed.' };
const MADE = { modFolder: '/mods/Harbor', repository: { sourceFolder: '/source/Harbor', assets: ['a.dds'], buildFile: '{}' } };

describe('decompileAndRepair', () => {
  let client: InMemoryMEditClient;
  let made: typeof MADE | { refusal: string };
  let linked: string[];
  let notLinked: string | undefined;
  const repairIn = (sourceMods: Record<string, string>, force = false) => {
    const newRepositories = {
      of: (mod: string) => Promise.resolve(mod === 'Harbor' ? made : { refusal: 'unasked' }),
      notLinked: (madeFor: ReadonlyMap<string, unknown>, committed: readonly string[]) => {
        linked.push(...committed.filter((mod) => madeFor.has(mod)));
        const why = notLinked;
        return Promise.resolve(new Map(why === undefined ? [] : committed.map((mod) => [mod, why] as const)));
      },
    };
    return pluginCommandsWith(fakeInstanceAdapter(readingFixture({ sourceRepositories: repositoriesOf(sourceMods) })).adapter, client, newRepositories)
      .decompileAndRepair([MALFORMED], force);
  };
  const sent = () => client.calls.filter((call) => call.method === 'decompileAndRepair').map((call) => call.args);
  const landingEach: MEditClient['decompileAndRepair'] = (plugins) => Promise.resolve({
    landed: plugins.map(({ plugin }) => plugin),
    refused: [REFUSED],
  });

  beforeEach(() => {
    client = new InMemoryMEditClient();
    client.setCommandHandler('decompileAndRepair', landingEach);
    made = MADE;
    linked = [];
    notLinked = undefined;
  });

  it('repairs each plugin, a mod with no repository handed the one version in git makes', async () => {
    expect(await repairIn({}, true)).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [REFUSED] } });
    expect(sent()).toEqual([[[{ plugin: MALFORMED, newRepository: MADE.repository }], true]]);
  });

  it('makes a repaired mod with no repository a source mod: its folder\'s manifest names the one made (source.md, Decompile and repair, story 4)', async () => {
    await repairIn({}, true);

    expect(linked).toEqual(['Harbor']);
  });

  it('names a repaired mod whose folder\'s manifest could not name its repository', async () => {
    notLinked = 'its manifest could not name its repository: EACCES';

    expect(await repairIn({}, true)).toEqual({ applied: true, outcome: {
      landed: [MALFORMED], refused: [REFUSED, { item: MALFORMED, reason: 'was repaired, but its manifest could not name its repository: EACCES.' }],
    } });
  });

  it('hands a mod a repository builds no new one, and links nothing', async () => {
    await repairIn({ Harbor: '/source/Harbor' }, true);

    expect([sent(), linked]).toEqual([[[[{ plugin: MALFORMED }], true]], []]);
  });

  it('sends the force it was given', async () => {
    await repairIn({ Harbor: '/source/Harbor' }, false);

    expect(sent().map(([, force]) => force)).toEqual([false]);
  });

  it('refuses a plugin whose mod has no repository and cannot be given one, naming why, and repairs nothing for it', async () => {
    made = { refusal: 'its metadata could not be read: EACCES' };

    const outcome = await repairIn({}, true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: MALFORMED, reason: 'Harbor has no repository, and one cannot be made: its metadata could not be read: EACCES' }] } });
    expect(sent()).toEqual([]);
  });
});
