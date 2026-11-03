import { describe, it, expect } from 'vitest';
import { createLootMetadata } from '../lootMetadata';

const RAW = 'https://raw.githubusercontent.com/loot';
const FALLOUT4_MASTERLIST = `${RAW}/fallout4/v0.29/masterlist.yaml`;
const STARFIELD_MASTERLIST = `${RAW}/starfield/v0.29/masterlist.yaml`;
const PRELUDE = `${RAW}/prelude/v0.29/prelude.yaml`;

const MASTERLIST_TEXT = 'plugins: []\n';
const PRELUDE_TEXT = '- &shared x\n';
const PAGE_OF_HTML = '<!DOCTYPE html>\n<html><body>Sign in to the network</body></html>\n';

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
    const { lootMetadata, asked } = hosting({ [FALLOUT4_MASTERLIST]: text(MASTERLIST_TEXT), [PRELUDE]: text(PRELUDE_TEXT) });

    expect(await lootMetadata.fetch('Fallout4')).toEqual({ found: true, masterlist: MASTERLIST_TEXT, prelude: PRELUDE_TEXT });
    expect([...asked].sort()).toEqual([FALLOUT4_MASTERLIST, PRELUDE]);
  });

  it('refuses a release LOOT has no repository for, asking nothing', async () => {
    const { lootMetadata, asked } = hosting({});

    expect(await lootMetadata.fetch('Oblivion')).toEqual({ found: false, reason: 'Modbench knows no LOOT repository for Oblivion.' });
    expect(asked).toEqual([]);
  });

  it.each<[string, Record<string, Response | Error>, string]>([
    ['the masterlist is not served', { [STARFIELD_MASTERLIST]: text('', 404), [PRELUDE]: text(PRELUDE_TEXT) }, 'LOOT did not serve the masterlist: 404'],
    ['the prelude is not served', { [STARFIELD_MASTERLIST]: text(MASTERLIST_TEXT), [PRELUDE]: text('', 503) }, 'LOOT did not serve the prelude: 503'],
    ['LOOT cannot be reached', { [STARFIELD_MASTERLIST]: new Error('getaddrinfo ENOTFOUND'), [PRELUDE]: text(PRELUDE_TEXT) }, 'Could not reach LOOT: getaddrinfo ENOTFOUND'],
    ['a page of HTML answers for the masterlist', { [STARFIELD_MASTERLIST]: text(PAGE_OF_HTML), [PRELUDE]: text(PRELUDE_TEXT) }, 'The masterlist is not LOOT metadata.'],
    ['a page of HTML answers for the prelude', { [STARFIELD_MASTERLIST]: text(MASTERLIST_TEXT), [PRELUDE]: text(PAGE_OF_HTML) }, 'The prelude is not LOOT metadata.'],
    ['the masterlist is not YAML', { [STARFIELD_MASTERLIST]: text('plugins: [unclosed\n'), [PRELUDE]: text(PRELUDE_TEXT) }, 'The masterlist does not read: Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:'],
  ])('refuses, giving nothing, when %s', async (_case, files, reason) => {
    const { lootMetadata } = hosting(files);

    expect(await lootMetadata.fetch('Starfield')).toEqual({ found: false, reason });
  });
});
