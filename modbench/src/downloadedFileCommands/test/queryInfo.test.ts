import { describe, it, expect } from 'vitest';
import { queryInfoOver } from '../queryInfo';
import { downloadedFilesOf, fakeInstanceAdapter, md5Of, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { GOOD_KEY, nexusAnswering } from '../../nexus/test/nexusDouble';

const search = (md5: string): string => `https://api.nexusmods.com/v1/games/fallout4/mods/md5_search/${md5}.json`;
const hit = (file_name: string) => ({ mod: { mod_id: 7, name: 'Sleep or Save' }, file_details: { file_id: 78, file_name, version: '1.2' } });
const known = (...names: string[]) => (url: string): Response => {
  const hits = names.filter((name) => url === search(md5Of(name))).map(hit);
  return new Response(JSON.stringify(hits), { status: hits.length > 0 ? 200 : 404 });
};

async function querying(names: readonly string[], nexusSays: (url: string) => Response | Error, answers: InstanceAnswers = {}, loggedIn = true) {
  const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: downloadedFilesOf('a.7z', 'b.7z') }), answers);
  const { nexus, sent } = nexusAnswering((_key, url) => nexusSays(url));
  if (loggedIn) await nexus.keep(GOOD_KEY);
  return { fake, sent, result: await queryInfoOver(fake.adapter, nexus)(names) };
}

describe('query info', () => {
  it('writes what Nexus knows of each file, found by the MD5 of the file', async () => {
    const { fake, result } = await querying(['a.7z', 'b.7z'], known('a.7z', 'b.7z'));

    const info = { game: 'fallout4', modID: '7', fileID: '78', version: '1.2', modName: 'Sleep or Save' };
    expect(result).toEqual({ applied: true, outcome: { landed: ['a.7z', 'b.7z'], refused: [] } });
    expect(fake.calls).toEqual([{ verb: 'writeNexusFileInfo', name: 'a.7z', info }, { verb: 'writeNexusFileInfo', name: 'b.7z', info }]);
  });

  it('leaves a file Nexus does not know as it was, refusing it by name, and goes on with the others', async () => {
    const { fake, result } = await querying(['a.7z', 'b.7z'], known('b.7z'));

    expect(result).toEqual({ applied: true, outcome: { landed: ['b.7z'], refused: [{ item: 'a.7z', reason: 'Nexus does not know this file.' }] } });
    expect(fake.calls.map((call) => call.verb)).toEqual(['writeNexusFileInfo']);
  });

  it('refuses a file whose MD5 cannot be read, asking Nexus nothing of it', async () => {
    const { fake, sent, result } = await querying(['a.7z'], known('a.7z'), { unreadableMd5s: new Map([['a.7z', 'EACCES: permission denied']]) });

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: 'a.7z', reason: 'EACCES: permission denied' }] } });
    expect([fake.calls, sent]).toEqual([[], []]);
  });

  it('refuses a file that is gone from disk', async () => {
    const { fake, result } = await querying(['gone.7z'], known());

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: 'gone.7z', reason: '"gone.7z" is gone from disk.' }] } });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a file whose metadata cannot be written', async () => {
    const { result } = await querying(['a.7z'], known('a.7z'), { refusals: refusing('writeNexusFileInfo', 'EACCES: permission denied') });

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: 'a.7z', reason: 'EACCES: permission denied' }] } });
  });

  it('asks Nexus nothing and refuses the whole selection while logged out', async () => {
    const { fake, sent, result } = await querying(['a.7z'], known('a.7z'), {}, false);

    expect(result).toEqual({ applied: false, refusal: 'You are not logged in to Nexus.' });
    expect([fake.calls, sent]).toEqual([[], []]);
  });
});
