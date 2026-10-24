import { describe, it, expect } from 'vitest';
import { acceptingGoodKey, FILE_78, GOOD_KEY, json, nexusAnswering, nexusServing, servingFile78 } from './nexusDouble';
import type { Nexus } from '../nexus';

describe('checking a key', () => {
  it('asks Nexus to validate it, naming the application and sending the key', async () => {
    const { nexus, sent } = nexusAnswering(acceptingGoodKey);

    await nexus.check(GOOD_KEY);

    const [request] = sent;
    expect(request?.url).toBe('https://api.nexusmods.com/v1/users/validate.json');
    expect(request?.headers.get('apikey')).toBe(GOOD_KEY);
    expect(request?.headers.get('Application-Name')).toBe('Modbench');
    expect(request?.headers.get('Application-Version')).toBe('1.2.3');
  });

  it('accepts a key Nexus accepts, and keeps nothing', async () => {
    const { nexus, secrets } = nexusAnswering(acceptingGoodKey);

    expect(await nexus.check(GOOD_KEY)).toEqual({ valid: true });
    expect(secrets.held.size).toBe(0);
  });

  it.each([
    ['refuses a key Nexus refuses', new Response('', { status: 401 }), 'Nexus refused this key.'],
    ['names the status when Nexus answers anything else', new Response('', { status: 503 }), 'Nexus answered 503.'],
    ['says why when Nexus cannot be reached', new Error('getaddrinfo ENOTFOUND'), 'Could not reach Nexus: getaddrinfo ENOTFOUND'],
  ])('%s', async (_name, answer, reason) => {
    const { nexus } = nexusAnswering(() => answer);

    expect(await nexus.check('k')).toEqual({ valid: false, reason });
  });
});

describe('keeping and forgetting a key', () => {
  it('is logged out until a key is kept, and logged out again once it is forgotten', async () => {
    const { nexus, secrets } = nexusAnswering(acceptingGoodKey);
    expect(await nexus.loggedIn()).toBe(false);

    await nexus.keep(GOOD_KEY);
    expect(await nexus.loggedIn()).toBe(true);
    expect([...secrets.held.values()]).toEqual([GOOD_KEY]);

    await nexus.forget();
    expect(await nexus.loggedIn()).toBe(false);
    expect(secrets.held.size).toBe(0);
  });

  it('tells a listener of each login change, and of no other secret', async () => {
    const { nexus, secrets } = nexusAnswering(acceptingGoodKey);
    let changes = 0;
    nexus.onDidChangeLogin(() => { changes++; });

    await nexus.keep(GOOD_KEY);
    await nexus.forget();
    await secrets.store('another.secret', 'x');

    expect(changes).toBe(2);
  });
});

describe('asking for a mod\'s newest version', () => {
  const FILES = 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files.json';
  const PAGE = 'https://api.nexusmods.com/v1/games/fallout4/mods/7.json';
  const MAIN = 1;
  const OLD = 4;
  const REMOVED = 6;
  const file = (file_id: number, version: string, category_id: number, file_name = `f${file_id}.7z`) => ({ file_id, version, category_id, file_name });
  const update = (old_file_id: number, new_file_id: number) => ({ old_file_id, new_file_id });

  const asking = async (answers: Record<string, Response | Error>, installed: { fileId?: string; fileName?: string; fileStatus?: number } = {}) => {
    const { nexus, sent } = await nexusServing(answers);
    return { result: await nexus.newestVersion({ game: 'fallout4', modId: '7', ...installed }), sent };
  };

  it('asks the mod\'s file list alone when the installed file is in it', async () => {
    const { sent } = await asking({ [FILES]: json({ files: [file(1, '1.0', MAIN)], file_updates: [] }) }, { fileId: '1' });

    expect(sent.map(({ url }) => url)).toEqual([FILES]);
  });

  it('gives the installed file\'s own version when nothing replaced it', async () => {
    const { result } = await asking({ [FILES]: json({ files: [file(1, '1.0', MAIN)], file_updates: [] }) }, { fileId: '1' });

    expect(result).toEqual({ found: true, version: '1.0' });
  });

  it.each([
    ['walks the update chain to the newest active file', [file(1, '1.0', OLD), file(2, '1.1', OLD), file(3, '1.2', MAIN)], [update(1, 2), update(2, 3)], '1.2'],
    ['prefers the newest of several active successors', [file(1, '1.0', OLD), file(2, '1.1', MAIN), file(3, '1.2', MAIN)], [update(1, 2), update(2, 3)], '1.2'],
    ['skips a successor the files list lacks', [file(1, '1.0', MAIN), file(2, '1.1', MAIN)], [update(1, 2), update(2, 3)], '1.1'],
    ['gives an obsolete file the newest successor that can still be downloaded', [file(1, '1.0', OLD), file(2, '1.1', OLD), file(3, '1.2', REMOVED)], [update(1, 2), update(2, 3)], '1.1'],
    ['ends a chain that loops, at the file the loop leaves it on', [file(1, '1.0', OLD), file(2, '1.1', OLD)], [update(1, 2), update(2, 1)], '1.0'],
  ])('%s', async (_name, files, file_updates, version) => {
    const { result } = await asking({ [FILES]: json({ files, file_updates }) }, { fileId: '1' });

    expect(result).toEqual({ found: true, version });
  });

  it('finds the installed file by its name when no file ID is recorded', async () => {
    const files = [file(1, '1.0', OLD, 'Mod-1.0.7z'), file(2, '2.0', MAIN, 'Mod-2.0.7z')];
    const { result } = await asking({ [FILES]: json({ files, file_updates: [update(1, 2)] }) }, { fileName: 'mod-1.0.7Z' });

    expect(result).toEqual({ found: true, version: '2.0' });
  });

  it('finds an archived file by the name the update chain keeps', async () => {
    const files = [file(2, '2.0', MAIN)];
    const updates = [{ old_file_id: 1, new_file_id: 2, old_file_name: 'Old.7z', new_file_name: 'f2.7z' }];
    const { result } = await asking({ [FILES]: json({ files, file_updates: updates }) }, { fileName: 'old.7z' });

    expect(result).toEqual({ found: true, version: '2.0' });
  });

  it('falls back to the mod page\'s version when no file can be told', async () => {
    const answers = { [FILES]: json({ files: [file(1, '1.0', MAIN)], file_updates: [] }), [PAGE]: json({ version: '3.0' }) };
    const { result, sent } = await asking(answers, { fileName: 'unknown.7z' });

    expect(result).toEqual({ found: true, version: '3.0' });
    expect(sent.map(({ url }) => url)).toEqual([FILES, PAGE]);
  });

  it.each([
    ['an optional file', 3],
    ['a miscellaneous file', 5],
  ])('refuses the mod page\'s version for %s, which Nexus versions apart from the mod', async (_name, fileStatus) => {
    const answers = { [FILES]: json({ files: [], file_updates: [] }), [PAGE]: json({ version: '3.0' }) };

    const { result, sent } = await asking(answers, { fileName: 'unknown.7z', fileStatus });

    expect(result).toEqual({ found: false, reason: "its file is an optional or miscellaneous file, whose version is not the mod's" });
    expect(sent.map(({ url }) => url)).toEqual([FILES]);
  });

  it('still gives the chain\'s version for an optional file', async () => {
    const { result } = await asking({ [FILES]: json({ files: [file(1, '1.0', 3)], file_updates: [] }) }, { fileId: '1', fileStatus: 3 });

    expect(result).toEqual({ found: true, version: '1.0' });
  });

  it.each([
    ['a file list in a form it does not read', '{"files":"none"}'],
    ['an answer that is not JSON', '<html>'],
  ])('refuses the mod, and does not fall back to the mod page, for %s', async (_name, body) => {
    const { result, sent } = await asking({ [FILES]: new Response(body, { status: 200 }), [PAGE]: json({ version: '3.0' }) }, { fileId: '1' });

    expect(result).toEqual({ found: false, reason: 'Nexus answered its file list in a form Modbench does not read.' });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['says Nexus does not hold a mod it answers 404 for', new Response('', { status: 404 }), 'Nexus does not hold this mod.'],
    ['names the status when Nexus answers anything else', new Response('', { status: 503 }), 'Nexus answered 503.'],
    ['says why when Nexus cannot be reached', new Error('getaddrinfo ENOTFOUND'), 'Could not reach Nexus: getaddrinfo ENOTFOUND'],
  ])('%s', async (_name, answer, reason) => {
    const { result } = await asking({ [FILES]: answer }, { fileId: '1' });

    expect(result).toEqual({ found: false, reason });
  });

});

describe('asking which file has an MD5', () => {
  const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
  const searchOf = (game: string): string => `https://api.nexusmods.com/v1/games/${game}/mods/md5_search/${MD5}.json`;
  const SEARCH = searchOf('fallout4');
  const LIST = 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files.json';
  const ACTIVE = 1;
  const ARCHIVED = 7;
  const hit = (file_name: string, category_id = ACTIVE, mod_id = 7, description: string | null = 'Main file') => ({
    mod: {
      mod_id, name: 'Sleep or Save', category_id: 12, author: 'Someone', uploaded_by: 'Uploader', uploaded_users_profile_url: 'https://nexus/users/1', version: '9.9',
    },
    file_details: { file_id: 78, name: 'Main', version: '1.2', mod_version: '1.0', category_id, file_name, ...(description === null ? {} : { description }) },
  });
  const asking = async (answer: Response | Error | Record<string, Response>, fileName = 'Sleep-7-1-2.7z', games = ['fallout4']) => {
    const { nexus, sent } = await nexusServing(answer instanceof Response || answer instanceof Error ? { [SEARCH]: answer } : answer);
    return { result: await nexus.fileByMd5({ games, md5: MD5, fileName }), sent };
  };

  it('sends the kept key to the MD5 search of the game', async () => {
    const { sent } = await asking(json([hit('Sleep-7-1-2.7z')]));

    expect(sent.map(({ url, headers }) => [url, headers.get('apikey')])).toEqual([[SEARCH, GOOD_KEY]]);
  });

  it('gives what Nexus knows of the file and its mod', async () => {
    const { result } = await asking(json([hit('Sleep-7-1-2.7z')]));

    expect(result).toEqual({
      found: true,
      info: {
        game: 'fallout4', modID: '7', fileID: '78', name: 'Main', version: '1.2', modVersion: '1.0', fileCategory: ACTIVE, description: 'Main file', modName: 'Sleep or Save',
        category: 12, author: 'Someone', uploader: 'Uploader', uploaderUrl: 'https://nexus/users/1',
      },
    });
  });

  it('gives only what Nexus names', async () => {
    const { result } = await asking(json([{ mod: { mod_id: 7 }, file_details: { file_id: 78, description: '' } }]));

    expect(result).toEqual({ found: true, info: { game: 'fallout4', modID: '7', fileID: '78' } });
  });

  it('asks the next game when one does not hold the file, and gives the game that does', async () => {
    const { result, sent } = await asking({ [searchOf('skyrim')]: json([hit('a.7z')]) }, 'a.7z', ['fallout4', 'skyrim']);

    expect(result).toMatchObject({ found: true, info: { game: 'skyrim' } });
    expect(sent.map(({ url }) => url)).toEqual([SEARCH, searchOf('skyrim')]);
  });

  it('asks no further game once one has answered several files it cannot choose among', async () => {
    const { result, sent } = await asking({ [SEARCH]: json([hit('a.7z', ACTIVE, 1), hit('b.7z', ACTIVE, 2)]) }, 'c.7z', ['fallout4', 'skyrim']);

    expect(result).toMatchObject({ found: false });
    expect(sent).toHaveLength(1);
  });

  describe('a hit that carries no description', () => {
    const entry = { file_id: 78, name: 'Listed', version: '2.0', category_id: 1, file_name: 'Sleep 7.7z', description: 'From the list', author: 'File author', uploaded_by: 'File uploader' };

    it.each([
      ['the file name Nexus holds', 'whatever.7z', 'Sleep 7.7z'],
      ['the downloaded file\'s name, its spaces as underscores', 'Sleep_7.7z', 'Sleep 7.7z'],
      ['the downloaded file\'s name without MO2\'s duplicate prefix', '2_Sleep 7.7z', 'Sleep 7.7z'],
    ])('has it from the mod\'s file list by %s', async (_name, fileName, listed) => {
      const { result } = await asking({ [SEARCH]: json([hit(listed, ACTIVE, 7, null)]), [LIST]: json({ files: [{ ...entry, file_name: listed }], file_updates: [] }) }, fileName);

      expect(result).toMatchObject({ found: true, info: { name: 'Listed', version: '2.0', description: 'From the list', author: 'File author', uploader: 'File uploader', modName: 'Sleep or Save', versionFromNewest: true } });
    });

    it('keeps what the search gave, and says the request failed, when the file list cannot be had', async () => {
      const { result } = await asking({ [SEARCH]: json([hit('a.7z', ACTIVE, 7, null)]) }, 'a.7z');

      expect(result).toMatchObject({ found: true, info: { name: 'Main', modID: '7' }, notice: 'Failed to request file info from Nexus: Nexus does not hold this mod.' });
    });

    it('keeps what the search gave, and says no file matches, when the file list names none of its names', async () => {
      const { result } = await asking({ [SEARCH]: json([hit('a.7z', ACTIVE, 7, null)]), [LIST]: json({ files: [{ ...entry, file_name: 'Other.7z' }], file_updates: [] }) }, 'a.7z');

      expect(result).toMatchObject({ found: true, info: { name: 'Main' }, notice: 'No matching file found on Nexus! Maybe this file was removed or renamed?' });
    });
  });

  it.each([
    ['the one whose file name is the downloaded file\'s, whatever the case', [hit('other.7z', ACTIVE, 1), hit('SLEEP-7-1-2.7Z', ACTIVE, 2)], '2'],
    ['the only active one when no file name is the downloaded file\'s', [hit('a.7z', ARCHIVED, 1), hit('b.7z', ACTIVE, 2)], '2'],
    ['the only active one when two files have the downloaded file\'s name', [hit('Sleep-7-1-2.7z', ARCHIVED, 1), hit('Sleep-7-1-2.7z', ACTIVE, 2)], '2'],
  ])('chooses among several %s', async (_name, hits, modID) => {
    const { result } = await asking(json(hits));

    expect(result).toMatchObject({ found: true, info: { modID } });
  });

  it.each([
    ['two active files have the downloaded file\'s name', [hit('Sleep-7-1-2.7z', ACTIVE, 1), hit('Sleep-7-1-2.7z', ACTIVE, 2)]],
    ['none is named so and two are active', [hit('a.7z', ACTIVE, 1), hit('b.7z', ACTIVE, 2)]],
  ])('refuses to choose when %s', async (_name, hits) => {
    const { result } = await asking(json(hits));

    expect(result).toEqual({ found: false, reason: 'Nexus holds several files with this MD5, and none is the one named so.' });
  });

  it.each([
    ['Nexus does not know the file', new Response('', { status: 404 }), 'Nexus does not know this file.'],
    ['Nexus answers an error', new Response('', { status: 503 }), 'Nexus answered 503.'],
    ['Nexus cannot be reached', new Error('offline'), 'Could not reach Nexus: offline'],
    ['Nexus answers no JSON', new Response('<html>', { status: 200 }), 'Nexus answered in a form Modbench does not read.'],
    ['Nexus answers a list that holds nothing', json([]), 'Nexus does not know this file.'],
    ['Nexus answers a hit without IDs', json([{ mod: {}, file_details: {} }]), 'Nexus answered in a form Modbench does not read.'],
  ])('refuses when %s', async (_name, answer, reason) => {
    const { result } = await asking(answer);

    expect(result).toEqual({ found: false, reason });
  });

});

describe('asking which file of a mod bears a name', () => {
  const PAGE = 'https://api.nexusmods.com/v1/games/fallout4/mods/7.json';
  const LIST = 'https://api.nexusmods.com/v1/games/fallout4/mods/7/files.json';
  const page = { name: '<b>Sleep</b> &amp; Save', category_id: 12, author: 'Someone', uploaded_by: 'Uploader', uploaded_users_profile_url: 'https://nexus/users/1' };
  const listed = { file_id: 78, name: 'Main', version: '1.2', category_id: 1, file_name: 'Sleep 7.7z', description: '[b]Main[/b]', uploaded_by: 'File uploader', uploaded_timestamp: 1455072761 };
  const asking = async (answers: Record<string, Response>, file: { fileID?: string; fileName?: string } = {}) => {
    const { nexus, sent } = await nexusServing(answers);
    return { result: await nexus.fileByName({ game: 'fallout4', modID: '7', fileName: 'Sleep_7.7z', ...file }), sent };
  };

  it('gives the mod from its page, as plain text, and the file from the list by its name', async () => {
    const { result } = await asking({ [PAGE]: json(page), [LIST]: json({ files: [listed], file_updates: [] }) });

    expect(result).toEqual({
      found: true,
      info: {
        game: 'fallout4', modID: '7', fileID: '78', name: 'Main', version: '1.2', fileCategory: 1, description: '[b]Main[/b]', fileTime: 1_455_072_761, versionFromNewest: true, modName: 'Sleep & Save', category: 12,
        author: 'Someone', uploader: 'File uploader', uploaderUrl: 'https://nexus/users/1',
      },
    });
  });

  it('asks for the page only when the file ID is known', async () => {
    const { result, sent } = await asking({ [PAGE]: json(page) }, { fileID: '78' });

    expect(result).toMatchObject({ found: true, info: { fileID: '78', modName: 'Sleep & Save' } });
    expect(sent.map(({ url }) => url)).toEqual([PAGE]);
  });

  it.each([
    ['the mod is not on Nexus', {}, 'Nexus does not hold this mod.'],
    ['the page is not an object', { [PAGE]: json([]) }, 'Nexus answered in a form Modbench does not read.'],
  ])('refuses when %s', async (_name, answers, reason) => {
    const { result } = await asking(answers);

    expect(result).toEqual({ found: false, reason });
  });

  it.each([
    ['no listed file bears the name', { [PAGE]: json(page), [LIST]: json({ files: [{ ...listed, file_name: 'Other.7z' }], file_updates: [] }) }, 'No matching file found on Nexus! Maybe this file was removed or renamed?'],
    ['the file list cannot be had', { [PAGE]: json(page) }, 'Failed to request file info from Nexus: Nexus does not hold this mod.'],
  ])('keeps what the page said, and says why the file is missing, when %s', async (_name, answers, notice) => {
    const { result } = await asking(answers);

    expect(result).toMatchObject({ found: true, info: { modName: 'Sleep & Save', author: 'Someone' }, notice });
    expect(result.found && result.info.fileID).toBeUndefined();
  });

});

describe('downloading a file', () => {
  const downloading = async (answers: Record<string, Response | Error>, loggedIn = true) => {
    const { nexus, sent } = await nexusServing(answers, loggedIn);
    return { result: await nexus.download({ game: 'fallout4', modID: '7', fileID: '78' }), sent };
  };

  it('downloads the file from the first server Nexus names, sending that server no key, with what Nexus knows of the file and its mod', async () => {
    const { result, sent } = await downloading(servingFile78('the bytes'));

    expect(result.found && await new Response(result.bytes).text()).toBe('the bytes');
    expect(result.found && result.info).toEqual({
      game: 'fallout4', modID: '7', fileID: '78', name: 'Main', version: '1.2', modVersion: '1.0', versionFromNewest: true, fileCategory: 1, fileTime: 1700000000,
      description: 'Main file', modName: 'Sleep & Save', category: 12, author: 'Someone', uploader: 'Uploader', uploaderUrl: 'https://nexus/users/1',
    });
    expect(sent.map(({ url }) => url)).toEqual([FILE_78.record, FILE_78.modPage, FILE_78.link, FILE_78.server]);
    expect(sent.map(({ headers }) => headers.get('apikey'))).toEqual([GOOD_KEY, GOOD_KEY, GOOD_KEY, null]);
  });

  it.each([
    ['says Nexus does not hold a file it answers 404 for', { [FILE_78.record]: new Response('', { status: 404 }) }, 'Nexus does not hold this file.'],
    ['says only a Premium account gets a download link when Nexus forbids one', { [FILE_78.link]: new Response('', { status: 403 }) }, 'Nexus gives a download link to a Premium account alone.'],
    ['says Nexus named no server when its list is empty', { [FILE_78.link]: json([]) }, 'Nexus named no server to download the file from.'],
    ['names the status the server answers', { [FILE_78.server]: new Response('', { status: 410 }) }, 'The server Nexus named answered 410.'],
    ['says why the server cannot be reached', { [FILE_78.server]: new Error('ECONNRESET') }, 'Could not reach the server Nexus named: ECONNRESET'],
  ])('%s', async (_name, answers, reason) => {
    const { result } = await downloading({ ...servingFile78('the bytes'), ...answers });

    expect(result).toEqual({ found: false, reason });
  });
});

describe('asking Nexus while logged out', () => {
  it.each<[string, (nexus: Nexus) => Promise<unknown>]>([
    ['a mod\'s newest version', (nexus) => nexus.newestVersion({ game: 'fallout4', modId: '7' })],
    ['which file has an MD5', (nexus) => nexus.fileByMd5({ games: ['fallout4'], md5: 'd41d8cd98f00b204e9800998ecf8427e', fileName: 'a.7z' })],
    ['which file of a mod bears a name', (nexus) => nexus.fileByName({ game: 'fallout4', modID: '7', fileName: 'a.7z' })],
    ['to download a file', (nexus) => nexus.download({ game: 'fallout4', modID: '7', fileID: '78' })],
  ])('refuses %s, asking nothing', async (_case, ask) => {
    const { nexus, sent } = await nexusServing(servingFile78('the bytes'), false);

    expect([await ask(nexus), sent]).toEqual([{ found: false, reason: 'You are not logged in to Nexus.' }, []]);
  });
});
