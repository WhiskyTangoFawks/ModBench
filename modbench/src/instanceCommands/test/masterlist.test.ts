import { describe, it, expect } from 'vitest';
import { masterlistCommands } from '../masterlist';
import { fakeInstanceAdapter, readingFixture, refusing } from '../../test/fakeInstanceAdapter';
import type { LootMetadata } from '../../lootMetadata/lootMetadata';

function over(lootMetadata: LootMetadata['fetch'], answers: Parameters<typeof fakeInstanceAdapter>[1] = {}) {
  const fake = fakeInstanceAdapter(readingFixture({ gameRelease: 'Fallout4' }), answers);
  return { fake, commands: masterlistCommands({ adapter: fake.adapter, lootMetadata: { fetch: lootMetadata } }) };
}

const serving = (masterlist: string, prelude: string): LootMetadata['fetch'] => () =>
  Promise.resolve({ found: true, masterlist, prelude });

describe('update', () => {
  it("puts the masterlist and prelude LOOT serves for the instance's game", async () => {
    const asked: string[] = [];
    const { fake, commands } = over((release) => {
      asked.push(release);
      return serving('plugins: []\n', 'common: []\n')(release);
    });

    expect(await commands.update()).toEqual({ applied: true, wrote: true });
    expect(asked).toEqual(['Fallout4']);
    expect(fake.calls).toEqual([{ verb: 'changeMasterlist', masterlist: 'plugins: []\n', prelude: 'common: []\n' }]);
  });

  it('writes nothing when the instance already holds what LOOT serves', async () => {
    const { commands } = over(serving('plugins: []\n', 'common: []\n'));
    await commands.update();

    expect(await commands.update()).toEqual({ applied: true, wrote: false });
  });

  it('refuses with the reason LOOT gave, writing nothing', async () => {
    const { fake, commands } = over(() => Promise.resolve({ found: false, reason: 'LOOT did not serve the masterlist: 404' }));

    expect(await commands.update()).toEqual({ applied: false, refusal: 'LOOT did not serve the masterlist: 404' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses, not throws, when the instance cannot take the files', async () => {
    const { commands } = over(serving('a', 'b'), { refusals: refusing('changeMasterlist', 'EACCES') });

    expect(await commands.update()).toEqual({ applied: false, refusal: 'EACCES' });
  });
});

describe('uncommitted', () => {
  it('names the files the instance holds uncommitted changes of', async () => {
    const { commands } = over(serving('a', 'b'), { uncommittedMasterlist: ['masterlist.yaml'] });

    expect(await commands.uncommitted()).toEqual(['masterlist.yaml']);
  });
});
