import { describe, it, expect } from 'vitest';
import { queryInfoOver } from '../queryInfo';
import { downloadedFilesOf, fakeInstanceAdapter, md5Of, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { json, nexusServing } from '../../nexus/test/nexusDouble';

const search = (md5: string): string => `https://api.nexusmods.com/v1/games/fallout4/mods/md5_search/${md5}.json`;
const hit = (file_name: string) => ({ mod: { mod_id: 7, name: 'Sleep or Save' }, file_details: { file_id: 78, file_name, version: '1.2', description: 'Main' } });
const known = (...names: string[]): Record<string, Response> =>
  Object.fromEntries(names.map((name) => [search(md5Of(name)), json([hit(name)])]));

async function querying(names: readonly string[], nexusSays: Record<string, Response | Error>, answers: InstanceAnswers = {}, loggedIn = true) {
  const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: downloadedFilesOf('a.7z', 'b.7z') }), answers);
  const { nexus, sent } = await nexusServing(nexusSays, loggedIn);
  return { fake, sent, result: await queryInfoOver(fake.adapter, nexus)(names) };
}

describe('query info', () => {
  it('writes what Nexus knows of each file, found by the MD5 of the file', async () => {
    const { fake, result } = await querying(['a.7z', 'b.7z'], known('a.7z', 'b.7z'));

    const info = { game: 'fallout4', modID: '7', fileID: '78', version: '1.2', description: 'Main', modName: 'Sleep or Save' };
    expect(result).toEqual({ applied: true, outcome: { landed: [{ name: 'a.7z' }, { name: 'b.7z' }], refused: [] } });
    expect(fake.calls).toEqual([{ verb: 'writeNexusFileInfo', name: 'a.7z', info }, { verb: 'writeNexusFileInfo', name: 'b.7z', info }]);
  });

  it('leaves a file Nexus does not know as it was, refusing it by name, and goes on with the others', async () => {
    const { fake, result } = await querying(['a.7z', 'b.7z'], known('b.7z'));

    expect(result).toEqual({ applied: true, outcome: { landed: [{ name: 'b.7z' }], refused: [{ item: { name: 'a.7z' }, reason: 'Nexus does not know this file.' }] } });
    expect(fake.calls.map((call) => call.verb)).toEqual(['writeNexusFileInfo']);
  });

  it('refuses a file whose MD5 cannot be read, asking Nexus nothing of it', async () => {
    const { fake, sent, result } = await querying(['a.7z'], known('a.7z'), { unreadableQueries: new Map([['a.7z', 'EACCES: permission denied']]) });

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'a.7z' }, reason: 'EACCES: permission denied' }] } });
    expect([fake.calls, sent]).toEqual([[], []]);
  });

  it('refuses a file that is gone from disk', async () => {
    const { fake, result } = await querying(['gone.7z'], known());

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'gone.7z' }, reason: '"gone.7z" is gone from disk.' }] } });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a file whose metadata cannot be written', async () => {
    const { result } = await querying(['a.7z'], known('a.7z'), { refusals: refusing('writeNexusFileInfo', 'EACCES: permission denied') });

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'a.7z' }, reason: 'EACCES: permission denied' }] } });
  });

  describe('when the MD5 settles nothing', () => {
    const PAGE = 'https://api.nexusmods.com/v1/games/fallout4/mods/7.json';
    const LIST = 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files.json';
    const page = () => json({ name: 'Sleep or Save', category_id: 12 });
    const byName = () => ({
      [PAGE]: page(),
      [LIST]: json({ files: [{ file_id: 78, name: 'Main', version: '1.2', file_name: 'a.7z' }], file_updates: [] }),
    });

    it('asks by the mod ID the metadata or the name gives, and writes what the page and list say', async () => {
      const { fake, result } = await querying(['a.7z'], byName(), { queries: new Map([['a.7z', { modID: '7' }]]) });

      expect(result).toEqual({ applied: true, outcome: { landed: [{ name: 'a.7z' }], refused: [] } });
      expect(fake.calls).toEqual([{
        verb: 'writeNexusFileInfo', name: 'a.7z', info: { game: 'fallout4', modID: '7', fileID: '78', name: 'Main', version: '1.2', modName: 'Sleep or Save', category: 12, versionFromNewest: true },
      }]);
    });

    it('asks the page alone when the metadata holds the file ID', async () => {
      const { fake, sent } = await querying(['a.7z'], byName(), { queries: new Map([['a.7z', { modID: '7', fileID: '78' }]]) });

      expect(sent.map(({ url }) => url)).not.toContain(LIST);
      expect(fake.calls).toMatchObject([{ info: { fileID: '78', modName: 'Sleep or Save' } }]);
    });

    it('refuses a file with no mod ID to ask by, saying what the MD5 said', async () => {
      const { fake, result } = await querying(['a.7z'], byName());

      expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'a.7z' }, reason: 'Nexus does not know this file.' }] } });
      expect(fake.calls).toEqual([]);
    });

    it('refuses a file whose mod is not on Nexus, saying what both said', async () => {
      const { fake, result } = await querying(['a.7z'], {}, { queries: new Map([['a.7z', { modID: '7' }]]) });

      expect(result).toEqual({
        applied: true,
        outcome: { landed: [], refused: [{ item: { name: 'a.7z' }, reason: 'Nexus does not know this file. By its mod ID 7: Nexus does not hold this mod.' }] },
      });
      expect(fake.calls).toEqual([]);
    });

    it('writes what the page said and carries MO2\'s notice when the mod\'s file list cannot be had', async () => {
      const { fake, result } = await querying(['a.7z'], { [PAGE]: page(), [LIST]: new Response('', { status: 503 }) }, { queries: new Map([['a.7z', { modID: '7' }]]) });

      const notice = 'Failed to request file info from Nexus: Nexus answered 503.';
      expect(result).toEqual({ applied: true, outcome: { landed: [{ name: 'a.7z', notice }], refused: [] } });
      expect(fake.calls).toMatchObject([{ verb: 'writeNexusFileInfo', info: { modID: '7', modName: 'Sleep or Save' } }]);
    });
  });

  it('asks Nexus nothing and refuses the whole selection while logged out', async () => {
    const { fake, sent, result } = await querying(['a.7z'], known('a.7z'), {}, false);

    expect(result).toEqual({ applied: false, refusal: 'You are not logged in to Nexus.' });
    expect([fake.calls, sent]).toEqual([[], []]);
  });
});
