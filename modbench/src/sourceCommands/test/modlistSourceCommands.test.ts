import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, GameFile, GameFolder, InstallationFile, InstanceAdapter, OriginFile } from '../../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { fakeInstanceAdapter, fileIn, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { modlistSourceCommands } from '../modlistSourceCommands';

const INSTALLED: InstallationFile = { path: '/downloads/ModA-1.0.7z', size: 10, hash: 'H', entries: [{ path: 'textures/a.dds', hash: 'E' }] };
const VANILLA: GameFile = { path: 'Game.esm', size: 7, hash: 'V' };
const FOUND: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };

const recording = (files: readonly InstallationFile[]): FileRead<readonly InstallationFile[]> => ({ kind: 'read', answer: files });
const instanceOf = (filesByMod: Record<string, readonly OriginFile[]>, gameFolder: GameFolder = FOUND) =>
  ({ filesByMod: new Map(Object.entries(filesByMod)), gameFolder });

const stagedNames = (mods: unknown): string[] => (Array.isArray(mods) ? mods.map((mod: { name: string }) => mod.name) : []);

function commandsOver(answers: InstanceAnswers = {}, client = new InMemoryMEditClient()) {
  const adapter = fakeInstanceAdapter(readingFixture(), answers);
  const repositories: string[] = [];
  const commands = modlistSourceCommands({
    client, adapter: adapter.adapter, instanceRoot: '/instance',
    makeRepository: () => { repositories.push('made'); return Promise.resolve(); },
  });
  return { commands, client, adapter, repositories };
}

describe('modlistSourceCommands init', () => {
  it('writes the ignore list, then makes the instance folder a repository', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.init({ holdsRepository: false });

    expect([result.applied, adapter.calls, repositories]).toEqual([true, [{ verb: 'writeIgnoreList' }], ['made']]);
  });

  it('refuses an instance folder that already holds a repository, naming it, and changes nothing', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.init({ holdsRepository: true });

    expect([result, repositories, adapter.calls]).toEqual([{ applied: false, refusal: '/instance already holds a repository.' }, [], []]);
  });

  it('makes no repository when the ignore list could not be written, and says why', async () => {
    const { commands, repositories } = commandsOver({ refusals: refusing('writeIgnoreList', '/instance/.gitignore already exists') });

    expect([await commands.init({ holdsRepository: false }), repositories]).toEqual([{ applied: false, refusal: '/instance/.gitignore already exists' }, []]);
  });

  it('takes back the ignore list it wrote when the repository could not be made, leaving nothing behind', async () => {
    const adapter = fakeInstanceAdapter();
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')),
    });

    const result = await commands.init({ holdsRepository: false });

    expect([result, adapter.calls]).toEqual([
      { applied: false, refusal: 'git is not available' }, [{ verb: 'writeIgnoreList' }, { verb: 'removeIgnoreList' }],
    ]);
  });

  it('names the ignore list that remains when it could not be taken back', async () => {
    const adapter = fakeInstanceAdapter(readingFixture(), { refusals: refusing('removeIgnoreList', 'read-only folder') });
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')),
    });

    expect(await commands.init({ holdsRepository: false })).toEqual({
      applied: false, refusal: 'git is not available; the ignore list it wrote remains: read-only folder',
    });
  });
});

describe('modlistSourceCommands stage', () => {
  const STAGED = { landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }], refused: [] };

  it('hands mEdit each mod with its folder, its installation files and the files the repository commits itself, and the game files its files override', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', recording([INSTALLED])]]), gameFiles: [VANILLA, { path: 'Other.esm', size: 1, hash: 'O' }],
    });
    client.setCommandResult('stage', STAGED);

    await commands.stage(['ModA', 'ModB'], instanceOf({ ModA: [fileIn('/mods/ModA', 'game.ESM')], ModB: [fileIn('/mods/ModB', 'a.nif')] }));

    expect(client.calls).toEqual([{
      method: 'stage',
      args: [
        [
          { name: 'ModA', folder: '/mods/ModA', installationFiles: [INSTALLED], committedFiles: ['meta.ini'] },
          { name: 'ModB', folder: '/mods/ModB', installationFiles: [], committedFiles: ['meta.ini'] },
        ],
        { gameFiles: [VANILLA], dataFolder: '/game/Data', buildFolder: '/build', deltaShare: 0.5 },
        { onProgress: expect.any(Function) as unknown },
      ],
    }]);
  });

  it('reports the phase of reading each mod\'s files, then mEdit\'s progress staging them', async () => {
    const { commands, client } = commandsOver();
    client.setCommandHandler('stage', (_mods, _facts, options) => {
      options?.onProgress?.({ mod: 'ModA', modsDone: 1, modsTotal: 2 });
      return Promise.resolve(STAGED);
    });
    const heard: unknown[] = [];

    await commands.stage(['ModA', 'ModB'], instanceOf({}), { onProgress: (status) => heard.push(status) });

    expect(heard).toEqual([
      { phase: 'ReadingFiles', mod: 'ModA' }, { phase: 'ReadingFiles', mod: 'ModB' }, { phase: 'Staging', mod: 'ModA', modsDone: 1, modsTotal: 2 },
    ]);
  });

  describe('refuses a mod, naming why, and stages the rest', () => {
    const adapterOf = fakeInstanceAdapter().adapter;
    const refusedFor: [string, Partial<InstanceAdapter>, string][] = [
      ['its name gives it no folder', { modFolderPath: (mod) => Promise.resolve(mod === 'ModA' ? undefined : `/mods/${mod}`) }, 'its name gives it no folder'],
      ['its installation files cannot be read', {
        installationFiles: (mod) => Promise.resolve(mod === 'ModA' ? { kind: 'unreadable', reason: 'its installation file is not indexed' } : { kind: 'read', answer: [] }),
      }, 'its installation file is not indexed'],
      ['the game files its files override cannot be read', {
        overriddenGameFiles: (dataFolder, paths) => (paths.includes('a.esm')
          ? Promise.resolve({ kind: 'unreadable', reason: 'Game.esm is locked' })
          : adapterOf.overriddenGameFiles(dataFolder, paths)),
      }, 'Game.esm is locked'],
    ];

    it.each(refusedFor)('when %s', async (_cause, override, reason) => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('stage', STAGED);
      const commands = modlistSourceCommands({
        client, adapter: { ...adapterOf, ...override }, instanceRoot: '/instance', makeRepository: () => Promise.resolve(),
      });

      const outcome = await commands.stage(['ModA', 'ModB'], instanceOf({ ModA: [fileIn('/mods/ModA', 'a.esm')], ModB: [fileIn('/mods/ModB', 'b.nif')] }));

      expect(client.calls.map((call) => stagedNames(call.args[0]))).toEqual([['ModB']]);
      expect(outcome).toEqual({ applied: true, ...STAGED, refused: [{ item: 'ModA', reason }] });
    });
  });

  it('hashes no game file for a mod refused for its folder or its installation files', async () => {
    const adapter = fakeInstanceAdapter(readingFixture(), { installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });
    const hashed: string[] = [];
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(), adapter: { ...adapter.adapter, overriddenGameFiles: (...args) => { hashed.push(args[1].join()); return adapter.adapter.overriddenGameFiles(...args); } },
      instanceRoot: '/instance', makeRepository: () => Promise.resolve(),
    });

    await commands.stage(['ModA'], instanceOf({ ModA: [fileIn('/mods/ModA', 'a.esm')] }));

    expect(hashed).toEqual([]);
  });

  it('does not call mEdit when no mod can be sent', async () => {
    const { commands, client } = commandsOver({ installations: new Map([['ModA', { kind: 'unreadable', reason: 'not indexed' }]]) });

    const outcome = await commands.stage(['ModA'], instanceOf({}));

    expect([client.calls, outcome]).toEqual([[], { applied: true, landed: [], refused: [{ item: 'ModA', reason: 'not indexed' }] }]);
  });

  it('refuses the whole stage with the message when mEdit refused the call', async () => {
    const { commands, client } = commandsOver();
    client.setCommandResult('stage', { refused: true, message: 'Could not stage 1 mod — mEdit is not running.' });

    expect(await commands.stage(['ModA'], instanceOf({}))).toEqual({ applied: false, refusal: 'Could not stage 1 mod — mEdit is not running.' });
  });

  it('refuses the whole stage when the game folder is not found, because a file cannot be matched to the game\'s', async () => {
    const { commands, client } = commandsOver();

    const outcome = await commands.stage(['ModA'], instanceOf({}, GAME_FOLDER_NOT_FOUND));

    expect([client.calls, outcome]).toEqual([[], { applied: false, refusal: 'Could not stage: the game folder was not found.' }]);
  });
});
