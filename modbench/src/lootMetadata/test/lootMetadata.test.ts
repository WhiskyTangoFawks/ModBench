import { describe, it, expect } from 'vitest';
import { createLootMetadata } from '../lootMetadata';
import { METADATA_BRANCH } from '../../sortingRules/lootMetadata';

const RAW = 'https://raw.githubusercontent.com/loot';

function hosting(files: Record<string, Response | Error>) {
  const asked: string[] = [];
  const lootMetadata = createLootMetadata({
    fetch: (url) => {
      asked.push(url);
      const answer = files[url] ?? new Response('', { status: 404 });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
  return { lootMetadata, asked };
}

const text = (body: string, status = 200) => new Response(body, { status });

describe('fetch', () => {
  it("reads the game's masterlist and the prelude, on the branch the parser reads", async () => {
    const { lootMetadata, asked } = hosting({
      [`${RAW}/fallout4/${METADATA_BRANCH}/masterlist.yaml`]: text('plugins: []\n'),
      [`${RAW}/prelude/${METADATA_BRANCH}/prelude.yaml`]: text('common: []\n'),
    });

    expect(await lootMetadata.fetch('Fallout4')).toEqual({ found: true, masterlist: 'plugins: []\n', prelude: 'common: []\n' });
    expect([...asked].sort()).toEqual([
      `${RAW}/fallout4/${METADATA_BRANCH}/masterlist.yaml`,
      `${RAW}/prelude/${METADATA_BRANCH}/prelude.yaml`,
    ]);
  });

  it('refuses a release LOOT has no repository for, asking nothing', async () => {
    const { lootMetadata, asked } = hosting({});

    expect(await lootMetadata.fetch('Oblivion')).toEqual({ found: false, reason: 'Modbench knows no LOOT repository for Oblivion.' });
    expect(asked).toEqual([]);
  });

  it.each([['masterlist'], ['prelude']])('refuses, naming the status, when LOOT does not serve the %s', async (missing) => {
    const { lootMetadata } = hosting({
      [`${RAW}/starfield/${METADATA_BRANCH}/masterlist.yaml`]: missing === 'masterlist' ? text('', 404) : text('a'),
      [`${RAW}/prelude/${METADATA_BRANCH}/prelude.yaml`]: missing === 'prelude' ? text('', 503) : text('b'),
    });

    expect(await lootMetadata.fetch('Starfield')).toEqual({ found: false, reason: `LOOT did not serve the ${missing}: ${missing === 'masterlist' ? 404 : 503}` });
  });

  it('refuses, with the network error, when LOOT cannot be reached', async () => {
    const { lootMetadata } = hosting({
      [`${RAW}/fallout4/${METADATA_BRANCH}/masterlist.yaml`]: new Error('getaddrinfo ENOTFOUND'),
      [`${RAW}/prelude/${METADATA_BRANCH}/prelude.yaml`]: text('b'),
    });

    expect(await lootMetadata.fetch('Fallout4')).toEqual({ found: false, reason: 'Could not reach LOOT: getaddrinfo ENOTFOUND' });
  });
});
