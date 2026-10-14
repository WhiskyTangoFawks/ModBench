import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { FileRead, GameFile, GameFolder, InstallationFile, OriginFile } from '../../instanceAdapter/instanceAdapter';
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
  it('makes the instance folder a repository, then writes its ignore list', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.init();

    expect([result.applied, repositories, adapter.calls]).toEqual([true, ['made'], [{ verb: 'writeIgnoreList' }]]);
  });

  it('refuses an instance folder that already holds a repository, naming it, and changes nothing', async () => {
    const { commands, adapter, repositories } = commandsOver({ repositoryHeld: true });

    const result = await commands.init();

    expect([result, repositories, adapter.calls]).toEqual([{ applied: false, refusal: '/instance already holds a repository.' }, [], []]);
  });

  it('writes no ignore list when the repository could not be made', async () => {
    const adapter = fakeInstanceAdapter();
    const commands = modlistSourceCommands({
      client: new InMemoryMEditClient(), adapter: adapter.adapter, instanceRoot: '/instance',
      makeRepository: () => Promise.reject(new Error('git is not available')),
    });

    const result = await commands.init();

    expect([result, adapter.calls]).toEqual([{ applied: false, refusal: 'git is not available' }, []]);
  });

  it('says so when the ignore list could not be written', async () => {
    const { commands } = commandsOver({ refusals: refusing('writeIgnoreList', 'read-only folder') });

    expect(await commands.init()).toEqual({ applied: false, refusal: 'read-only folder' });
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
      ],
    }]);
  });

  it('refuses a mod whose installation files or overridden game files cannot be read, naming why, and stages the rest', async () => {
    const { commands, client } = commandsOver({
      installations: new Map([['ModA', { kind: 'unreadable', reason: 'its installation file is not indexed' }]]),
    });
    client.setCommandResult('stage', STAGED);

    const outcome = await commands.stage(['ModA', 'ModB'], instanceOf({}));

    expect(client.calls.map((call) => stagedNames(call.args[0]))).toEqual([['ModB']]);
    expect(outcome).toEqual({ applied: true, ...STAGED, refused: [{ item: 'ModA', reason: 'its installation file is not indexed' }] });
  });

  it('calls mEdit with nothing when no mod can be sent', async () => {
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
