import { describe, it, expect } from 'vitest';
import { recordingTasks } from '../../test/recordingTasks';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { OtherManifest } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { modlistRepositoryCommands } from '../modlistRepositoryCommands';
import type { HostGit } from '../../ports/repository';
import { hostGitFailingToActivate, hostGitRecordingInits } from './hostGitDouble';
import { answeringFrom, nexusAnswering } from '../../nexus/test/nexusDouble';
import { fileProblemsFake } from '../../test/fileProblemsFake';

const STOCK_GAME: OtherManifest = { name: 'Stock Game/', folder: '/instance/Stock Game' };

function commandsOver(answers: InstanceAnswers = {}, hostGit?: HostGit<string>) {
  const adapter = fakeInstanceAdapter(readingFixture(), answers);
  const repositories: string[] = [];
  const commands = modlistRepositoryCommands({
    client: new InMemoryMEditClient(), adapter: adapter.adapter, nexus: nexusAnswering(answeringFrom({})).nexus, instanceRoot: '/instance',
    hostGit: hostGit ?? hostGitRecordingInits(repositories), trash: () => Promise.resolve(), tasks: recordingTasks(), pathProblems: fileProblemsFake(),
  });
  return { commands, adapter, repositories };
}

describe('modlistRepositoryCommands git init', () => {
  it('writes the ignore list, makes the instance folder a repository, then makes it refuse a push of a pin its remote lacks and hold paths by path tokens', async () => {
    const { commands, adapter, repositories } = commandsOver();

    const result = await commands.gitInit();

    expect([result.applied, adapter.calls, repositories]).toEqual([
      true, [{ verb: 'checkPushRefusalFree' }, { verb: 'writeIgnoreList' }, { verb: 'refuseUnpublishedPins' }, { verb: 'keepOutOfPublisher' }, { verb: 'writePathTokens' }], ['uri:/instance'],
    ]);
  });

  it('names why a path token stays in the working tree beside the repository it made', async () => {
    const { commands } = commandsOver({ pathTokenLeft: 'ModOrganizer.ini still holds a path token' });

    expect(await commands.gitInit()).toEqual({ applied: true, pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' });
  });

  it('takes back the repository, the ignore list and the publisher\'s ignore list entries it made when the path tokens could not be written, naming why', async () => {
    const { commands, adapter } = commandsOver({ refusals: refusing('writePathTokens', 'could not lock config file .git/config') });

    expect([await commands.gitInit(), adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: 'could not lock config file .git/config' },
      ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'writePathTokens', 'takeBackKeepOutOfPublisher', 'takeBackPushRefusal', 'removeRepository', 'takeBackIgnoreList'],
    ]);
  });

  describe('on an instance folder that holds a repository', () => {
    it('adds the ignore list, the push check and the path tokens, and makes no repository', async () => {
      const { commands, adapter, repositories } = commandsOver({ repositoryOnDisk: true });

      const result = await commands.gitInit();

      expect([result, repositories, adapter.calls]).toEqual([
        { applied: true }, [], [{ verb: 'writeIgnoreList' }, { verb: 'refuseUnpublishedPins' }, { verb: 'keepOutOfPublisher' }, { verb: 'writePathTokens' }],
      ]);
    });

    it('keeps another pre-push hook, names why the push check is not written, and still writes the path tokens', async () => {
      const { commands, adapter } = commandsOver({
        repositoryOnDisk: true, refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push already exists'),
      });

      expect([await commands.gitInit(), adapter.calls.map(({ verb }) => verb)]).toEqual([
        { applied: true, pushRefusalNotWritten: '/instance/.git/hooks/pre-push already exists' },
        ['writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'writePathTokens'],
      ]);
    });

    it('takes back the push check and the ignore list it added, and not the repository, when the path tokens could not be written', async () => {
      const { commands, adapter, repositories } = commandsOver({ repositoryOnDisk: true, refusals: refusing('writePathTokens', 'could not lock config file') });

      expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
        { applied: false, refusal: 'could not lock config file' }, [], ['writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'writePathTokens', 'takeBackKeepOutOfPublisher', 'takeBackPushRefusal', 'takeBackIgnoreList'],
      ]);
    });
  });

  it('takes back everything before the publisher\'s ignore list when it could not be written', async () => {
    const { commands, repositories, adapter } = commandsOver({ refusals: refusing('keepOutOfPublisher', 'compiler_settings.json cannot be written') });

    expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: 'compiler_settings.json cannot be written' }, ['uri:/instance'],
      ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'keepOutOfPublisher', 'takeBackPushRefusal', 'removeRepository', 'takeBackIgnoreList'],
    ]);
  });

  it('refuses before it writes anything when the publisher\'s configuration cannot be read, naming why', async () => {
    const { commands, repositories, adapter } = commandsOver({ unreadablePublisher: 'compiler_settings.json is not JSON' });

    expect([await commands.gitInit(), repositories, adapter.calls]).toEqual([{ applied: false, refusal: 'compiler_settings.json is not JSON' }, [], [{ verb: 'checkPushRefusalFree' }]]);
  });

  it('makes no repository when the ignore list could not be written, and says why', async () => {
    const { commands, repositories } = commandsOver({ refusals: refusing('writeIgnoreList', '/instance/.gitignore already exists') });

    expect([await commands.gitInit(), repositories]).toEqual([{ applied: false, refusal: '/instance/.gitignore already exists' }, []]);
  });

  it('refuses before it writes anything when the push refusal has no free place, naming why', async () => {
    const { commands, adapter, repositories } = commandsOver({ refusals: refusing('checkPushRefusalFree', '/instance/.git/hooks/pre-push already exists') });

    expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: '/instance/.git/hooks/pre-push already exists' }, [], ['checkPushRefusalFree'],
    ]);
  });

  it('takes back the repository and the ignore list it made when the push refusal could not be written, naming why', async () => {
    const { commands, adapter, repositories } = commandsOver({ refusals: refusing('refuseUnpublishedPins', '/instance/.git/hooks/pre-push already exists') });

    expect([await commands.gitInit(), repositories, adapter.calls.map(({ verb }) => verb)]).toEqual([
      { applied: false, refusal: '/instance/.git/hooks/pre-push already exists' },
      ['uri:/instance'], ['checkPushRefusalFree', 'writeIgnoreList', 'refuseUnpublishedPins', 'removeRepository', 'takeBackIgnoreList'],
    ]);
  });

  it('names the repository that remains when it could not be taken back', async () => {
    const { commands } = commandsOver({
      refusals: (call) => ({ refuseUnpublishedPins: 'a hook is there', removeRepository: 'read-only folder' })[call.verb as string],
    });

    expect(await commands.gitInit()).toEqual({
      applied: false, refusal: 'a hook is there; the repository it made remains: read-only folder',
    });
  });

  it('takes back the ignore list it wrote when the repository could not be made, leaving nothing behind', async () => {
    const { commands, adapter } = commandsOver({}, hostGitFailingToActivate('git is not available'));

    const result = await commands.gitInit();

    expect([result, adapter.calls]).toEqual([
      { applied: false, refusal: 'git is not available' }, [{ verb: 'checkPushRefusalFree' }, { verb: 'writeIgnoreList' }, { verb: 'takeBackIgnoreList' }],
    ]);
  });

  it('names the ignore list that remains when it could not be taken back', async () => {
    const { commands } = commandsOver({ refusals: refusing('takeBackIgnoreList', 'read-only folder') }, hostGitFailingToActivate('git is not available'));

    expect(await commands.gitInit()).toEqual({
      applied: false, refusal: 'git is not available; the ignore list it wrote remains: read-only folder',
    });
  });
});

describe('modlistRepositoryCommands other manifests', () => {
  it('are the folders outside the mod folders the Instance adapter finds a manifest in, each folder it could not read refused', async () => {
    const { commands } = commandsOver({ otherManifests: [STOCK_GAME], unsearched: [{ name: 'logs/', reason: 'EACCES' }] });

    expect(await commands.otherManifests()).toEqual({
      others: [STOCK_GAME], refused: [{ item: 'logs/', reason: 'was not searched for a manifest: EACCES' }],
    });
  });

  it('are refused as one, naming why, when the instance could not be searched for them', async () => {
    const { commands } = commandsOver({ unreadReads: { otherManifests: 'download_directory "%X%" could not be resolved' } });

    expect(await commands.otherManifests()).toEqual({
      others: [], refused: [{ item: 'every other manifest', reason: 'was not searched for: download_directory "%X%" could not be resolved' }],
    });
  });
});
