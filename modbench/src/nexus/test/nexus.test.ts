import { describe, it, expect } from 'vitest';
import { acceptingGoodKey, GOOD_KEY, nexusAnswering } from './nexusDouble';

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
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

  const asking = async (answers: Record<string, Response>, installed: { fileId?: string; fileName?: string } = {}) => {
    const { nexus, sent } = nexusAnswering((_key, url) => answers[url] ?? new Response('', { status: 404 }));
    await nexus.keep(GOOD_KEY);
    return { result: await nexus.newestVersion({ game: 'fallout4', modId: '7', ...installed }), sent };
  };

  it('sends the kept key and names the application', async () => {
    const { sent } = await asking({ [FILES]: json({ files: [file(1, '1.0', MAIN)], file_updates: [] }) }, { fileId: '1' });

    expect(sent.map(({ url }) => url)).toEqual([FILES]);
    expect(sent[0]?.headers.get('apikey')).toBe(GOOD_KEY);
    expect(sent[0]?.headers.get('Application-Name')).toBe('Modbench');
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
    const answers: Record<string, Response> = { [FILES]: json({ files: [], file_updates: [] }), [PAGE]: json({ version: '3.0' }) };
    const { nexus, sent } = nexusAnswering((_key, url) => answers[url] ?? new Response('', { status: 404 }));
    await nexus.keep(GOOD_KEY);

    const result = await nexus.newestVersion({ game: 'fallout4', modId: '7', fileName: 'unknown.7z', fileStatus });

    expect(result.found).toBe(false);
    expect(sent.map(({ url }) => url)).toEqual([FILES]);
  });

  it('still gives the chain\'s version for an optional file', async () => {
    const { nexus } = nexusAnswering(() => json({ files: [file(1, '1.0', 3)], file_updates: [] }));
    await nexus.keep(GOOD_KEY);

    expect(await nexus.newestVersion({ game: 'fallout4', modId: '7', fileId: '1', fileStatus: 3 })).toEqual({ found: true, version: '1.0' });
  });

  it.each([
    ['a file list in a form it does not read', '{"files":"none"}'],
    ['an answer that is not JSON', '<html>'],
  ])('refuses the mod, and does not fall back to the mod page, for %s', async (_name, body) => {
    const { nexus, sent } = nexusAnswering(() => new Response(body, { status: 200 }));
    await nexus.keep(GOOD_KEY);

    const result = await nexus.newestVersion({ game: 'fallout4', modId: '7', fileId: '1' });

    expect(result.found).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['says Nexus does not hold a mod it answers 404 for', new Response('', { status: 404 }), 'Nexus does not hold this mod.'],
    ['names the status when Nexus answers anything else', new Response('', { status: 503 }), 'Nexus answered 503.'],
    ['says why when Nexus cannot be reached', new Error('getaddrinfo ENOTFOUND'), 'Could not reach Nexus: getaddrinfo ENOTFOUND'],
  ])('%s', async (_name, answer, reason) => {
    const { nexus } = nexusAnswering(() => answer);
    await nexus.keep(GOOD_KEY);

    expect(await nexus.newestVersion({ game: 'fallout4', modId: '7', fileId: '1' })).toEqual({ found: false, reason });
  });

  it('asks nothing while logged out', async () => {
    const { nexus, sent } = nexusAnswering(acceptingGoodKey);

    expect(await nexus.newestVersion({ game: 'fallout4', modId: '7' })).toEqual({ found: false, reason: 'You are not logged in to Nexus.' });
    expect(sent).toEqual([]);
  });
});

describe('asking which file has an MD5', () => {
  const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
  const SEARCH = `https://api.nexusmods.com/v1/games/fallout4/mods/md5_search/${MD5}.json`;
  const ACTIVE = 1;
  const ARCHIVED = 7;
  const hit = (file_name: string, category_id = ACTIVE, mod_id = 7) => ({
    mod: {
      mod_id, name: 'Sleep or Save', category_id: 12, author: 'Someone', uploaded_by: 'Uploader', uploaded_users_profile_url: 'https://nexus/users/1',
    },
    file_details: { file_id: 78, name: 'Main', version: '1.2', mod_version: '1.0', category_id, file_name },
  });
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
  const asking = async (answer: Response | Error, fileName = 'Sleep-7-1-2.7z') => {
    const { nexus, sent } = nexusAnswering(() => answer);
    await nexus.keep(GOOD_KEY);
    return { result: await nexus.fileByMd5({ game: 'fallout4', md5: MD5, fileName }), sent };
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
        game: 'fallout4', modID: '7', fileID: '78', name: 'Main', version: '1.2', fileCategory: ACTIVE, modName: 'Sleep or Save', category: 12,
        author: 'Someone', uploader: 'Uploader', uploaderUrl: 'https://nexus/users/1',
      },
    });
  });

  it('gives the mod\'s version when the file has none', async () => {
    const body = hit('a.7z');
    const { result } = await asking(json([{ ...body, file_details: { ...body.file_details, version: '' } }]), 'a.7z');

    expect(result).toMatchObject({ found: true, info: { version: '1.0' } });
  });

  it('gives only what Nexus names', async () => {
    const { result } = await asking(json([{ mod: { mod_id: 7 }, file_details: { file_id: 78 } }]));

    expect(result).toEqual({ found: true, info: { game: 'fallout4', modID: '7', fileID: '78' } });
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

  it('asks nothing while logged out', async () => {
    const { nexus, sent } = nexusAnswering(acceptingGoodKey);

    expect(await nexus.fileByMd5({ game: 'fallout4', md5: MD5, fileName: 'a.7z' })).toEqual({ found: false, reason: 'You are not logged in to Nexus.' });
    expect(sent).toEqual([]);
  });
});
