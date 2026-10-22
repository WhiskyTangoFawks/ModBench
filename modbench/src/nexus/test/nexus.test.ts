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

  it('walks the update chain to the newest active file', async () => {
    const files = [file(1, '1.0', OLD), file(2, '1.1', OLD), file(3, '1.2', MAIN)];
    const { result } = await asking({ [FILES]: json({ files, file_updates: [update(1, 2), update(2, 3)] }) }, { fileId: '1' });

    expect(result).toEqual({ found: true, version: '1.2' });
  });

  it('prefers the newest of several active successors', async () => {
    const files = [file(1, '1.0', OLD), file(2, '1.1', MAIN), file(3, '1.2', MAIN)];
    const { result } = await asking({ [FILES]: json({ files, file_updates: [update(1, 2), update(2, 3)] }) }, { fileId: '1' });

    expect(result).toEqual({ found: true, version: '1.2' });
  });

  it('skips a successor the files list lacks', async () => {
    const files = [file(1, '1.0', MAIN), file(2, '1.1', MAIN)];
    const { result } = await asking({ [FILES]: json({ files, file_updates: [update(1, 2), update(2, 3)] }) }, { fileId: '1' });

    expect(result).toEqual({ found: true, version: '1.1' });
  });

  it('gives an obsolete file the newest successor that can still be downloaded', async () => {
    const files = [file(1, '1.0', OLD), file(2, '1.1', OLD), file(3, '1.2', REMOVED)];
    const { result } = await asking({ [FILES]: json({ files, file_updates: [update(1, 2), update(2, 3)] }) }, { fileId: '1' });

    expect(result).toEqual({ found: true, version: '1.1' });
  });

  it('ends a chain that loops', async () => {
    const files = [file(1, '1.0', OLD), file(2, '1.1', OLD)];
    const { result } = await asking({ [FILES]: json({ files, file_updates: [update(1, 2), update(2, 1)] }) }, { fileId: '1' });

    expect(result.found).toBe(true);
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
