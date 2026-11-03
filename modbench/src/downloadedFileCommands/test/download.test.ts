import { describe, it, expect } from 'vitest';
import { downloadOver } from '../download';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { FILE_78, json, nexusServing, servingFile78 } from '../../nexus/test/nexusDouble';

const LIST = 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files.json';
const files = () => json({
  files: [
    { file_id: 78, name: 'Main', version: '1.2', category_id: 1, category_name: 'MAIN', file_name: 'Sleep-7-1-2.7z' },
    { file_id: 80, name: 'Extras', version: '1.0', category_id: 3, category_name: 'OPTIONAL', file_name: 'Extras-7-1-0.7z' },
  ],
  file_updates: [],
});

async function downloading(nexusSays: Record<string, Response | Error>, mod: string, file?: string, { loggedIn = true, held = [] as string[] } = {}) {
  const fake = fakeInstanceAdapter(readingFixture(), { downloadedFiles: new Map(held.map((name) => [name, { kind: 'read' as const, answer: { path: `/downloads/${name}`, size: 1, hash: 'h', entries: [] } }])) });
  const { nexus, sent } = await nexusServing({ [LIST]: files(), ...nexusSays }, loggedIn);
  const { download } = downloadOver(fake.adapter, nexus);
  return { fake, sent, result: await download({ mod, file }) };
}

describe('download', () => {
  it.each([
    ['its ID, in the instance\'s game', '7'],
    ['its Nexus page address', 'https://www.nexusmods.com/fallout4/mods/7'],
  ])('puts the file of a mod named by %s in the downloads under the name Nexus gives it, with what Nexus knows of it', async (_how, mod) => {
    const { fake, result } = await downloading(servingFile78('the bytes'), mod, '78');

    expect(result).toEqual({ applied: true, name: 'Sleep-7-1-2.7z' });
    expect(fake.calls).toMatchObject([{ verb: 'putDownloadedFile', name: 'Sleep-7-1-2.7z', info: { game: 'fallout4', modID: '7', fileID: '78', modName: 'Sleep & Save' } }]);
  });

  it('takes the file a page address names', async () => {
    const { result } = await downloading(servingFile78('the bytes'), FILE_78.page);

    expect(result).toEqual({ applied: true, name: 'Sleep-7-1-2.7z' });
  });

  it('takes the game a page address names over the instance\'s', async () => {
    const { sent, result } = await downloading({}, 'https://www.nexusmods.com/skyrimspecialedition/mods/7', '78');

    expect(result).toEqual({ applied: false, refusal: 'Nexus does not hold this file.' });
    expect(sent.map(({ url }) => url)).toEqual(['https://api.nexusmods.com/v1/games/skyrimspecialedition/mods/7/files/78.json']);
  });

  it('refuses a request that names no file, listing the mod\'s files as the pick shows them, and asks Nexus for no download link', async () => {
    const { fake, sent, result } = await downloading(servingFile78('the bytes'), '7');

    expect(result).toEqual({
      applied: false,
      refusal: 'Name the file to download. The files of mod 7: file 78, Main, 1.2, MAIN; file 80, Extras, 1.0, OPTIONAL.',
    });
    expect([fake.calls, sent.map(({ url }) => url)]).toEqual([[], [LIST]]);
  });

  it.each(['seven', 'https://example.com/fallout4/mods/7', '7 '])('refuses %j, which is neither a mod ID nor a Nexus page address, asking Nexus nothing', async (mod) => {
    const { fake, sent, result } = await downloading(servingFile78('the bytes'), mod, '78');

    expect(result).toEqual({ applied: false, refusal: `'${mod}' is neither a Nexus mod ID nor the address of a mod's page on Nexus.` });
    expect([fake.calls, sent]).toEqual([[], []]);
  });

  it('refuses a file ID that is not a number', async () => {
    const { sent, result } = await downloading(servingFile78('the bytes'), '7', 'Main');

    expect(result).toEqual({ applied: false, refusal: "'Main' is not a Nexus file ID." });
    expect(sent).toEqual([]);
  });

  it('refuses on an account Nexus gives no download link, putting nothing', async () => {
    const { fake, result } = await downloading({ ...servingFile78('the bytes'), [FILE_78.link]: new Response('', { status: 403 }) }, '7', '78');

    expect(result).toEqual({ applied: false, refusal: 'Nexus gives a download link to a Premium account alone.' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a name the downloads folder holds', async () => {
    const { result } = await downloading(servingFile78('the bytes'), '7', '78', { held: ['Sleep-7-1-2.7z'] });

    expect(result).toEqual({ applied: false, refusal: "'Sleep-7-1-2.7z' is already in the downloads folder" });
  });

  it('refuses while logged out, asking Nexus nothing', async () => {
    const { sent, result } = await downloading(servingFile78('the bytes'), '7', '78', { loggedIn: false });

    expect(result).toEqual({ applied: false, refusal: 'You are not logged in to Nexus.' });
    expect(sent).toEqual([]);
  });
});

describe("the pick of a mod's files", () => {
  it('lists the files of the mod, each with its ID, name, version and category', async () => {
    const fake = fakeInstanceAdapter();
    const { nexus } = await nexusServing({ [LIST]: files() });

    expect(await downloadOver(fake.adapter, nexus).filesOf('7')).toEqual({
      applied: true,
      files: [{ fileID: '78', name: 'Main', version: '1.2', category: 'MAIN' }, { fileID: '80', name: 'Extras', version: '1.0', category: 'OPTIONAL' }],
    });
  });

  it('is the file a page address names, when it names one, and no list', async () => {
    const fake = fakeInstanceAdapter();
    const { nexus, sent } = await nexusServing({ [LIST]: files() });

    expect(await downloadOver(fake.adapter, nexus).filesOf(FILE_78.page)).toEqual({ applied: true, files: [], named: '78' });
    expect(sent).toEqual([]);
  });
});
