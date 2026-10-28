import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import type { InstanceValue, ProgramVersion } from '../../instanceLoader/instance';
import { ToolboxProvider } from '../ToolboxProvider';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';

const GAME_FOLDER = '/games/Fallout 4';
const VALUE = instanceValueFixture({
  activeProfile: 'Survival',
  gameFolder: { kind: 'found', root: GAME_FOLDER, dataFolder: `${GAME_FOLDER}/Data` },
  programVersions: { kind: 'found', game: { kind: 'read', version: '1.10.163.0' }, extender: { kind: 'read', version: '0.0.6.23' } },
});

const SILENT = { warn: () => undefined };

class FakeDeploymentFolder {
  private readonly listeners: (() => void)[] = [];

  readonly id = 'modbench.deployment.folder';

  constructor(public current?: string) {}

  inspect = (): { workspaceValue?: string; globalValue?: string } => ({ workspaceValue: this.current });

  nameOf = (path: string) => path.split('/').pop() ?? '';

  changed = (listener: () => void) => { this.listeners.push(listener); return { dispose: () => undefined }; };

  set(folder: string | undefined): void {
    this.current = folder;
    this.listeners.forEach((listener) => listener());
  }
}

const providerOf = (instance: FakeInstance, deploymentFolder = new FakeDeploymentFolder()) =>
  new ToolboxProvider({ instance, channel: SILENT, deploymentFolder });

function rowsOf(instance: FakeInstance) {
  return providerOf(instance).getChildren();
}

function row(instance: FakeInstance, label: string, deploymentFolder?: FakeDeploymentFolder) {
  return present(providerOf(instance, deploymentFolder).getChildren().find((r) => r.label === label), `the ${label} row`);
}

describe('the Toolbox view, given an instance value', () => {
  it('shows a Game row, then Profile, Modlist and Deployment rows, and nothing else', () => {
    expect(rowsOf(new FakeInstance(VALUE)).map((r) => r.label)).toEqual(['Game', 'Profile', 'Modlist', 'Deployment']);
  });

  it('reads the game as MO2 names it, and no click', () => {
    const game = row(new FakeInstance(VALUE), 'Game');

    expect(game.description).toBe('Fallout 4');
    expect(game.iconPath).toEqual(new ThemeIcon('game'));
    expect(game.command).toBeUndefined();
  });

  describe('the Game row\'s tooltip, given the versions the game folder holds', () => {
    const NO_LOADER: ProgramVersion = { kind: 'notFound', program: 'f4se_loader.exe' };
    const read = (version: string): ProgramVersion => ({ kind: 'read', version });
    const found = (game: ProgramVersion, extender: ProgramVersion): InstanceValue['programVersions'] => ({ kind: 'found', game, extender });

    it.each<[string, InstanceValue['programVersions'], string]>([
      ['the game\'s and the extender\'s versions', found(read('1.10.163.0'), read('0.0.6.23')), 'Game: 1.10.163.0\nScript extender: 0.0.6.23'],
      ['that the game folder holds no loader', found(read('1.10.163.0'), NO_LOADER), 'Game: 1.10.163.0\nScript extender: none'],
      ['a loader with no version resource', found(read('1.10.163.0'), { kind: 'noVersionResource', program: 'f4se_loader.exe' }),
        'Game: 1.10.163.0\nScript extender: f4se_loader.exe has no version resource'],
      ['a loader that is no program', found(read('1.10.163.0'), { kind: 'notAProgram', program: 'f4se_loader.exe' }),
        'Game: 1.10.163.0\nScript extender: f4se_loader.exe is not a Windows program'],
      ['a loader the file system would not read, and why', found(read('1.10.163.0'), { kind: 'unreadable', program: 'f4se_loader.exe', why: 'EACCES' }),
        'Game: 1.10.163.0\nScript extender: f4se_loader.exe cannot be read: EACCES'],
      ['a game program the game folder lacks', found({ kind: 'notFound', program: 'Fallout4.exe' }, read('0.0.6.23')),
        'Game: Fallout4.exe not found\nScript extender: 0.0.6.23'],
      ['that Modbench knows no program of the game', { kind: 'unknownGame' }, 'Modbench knows no program of this game'],
    ])('names the game folder, then %s', (_, programVersions, lines) => {
      expect(row(new FakeInstance({ ...VALUE, programVersions }), 'Game').tooltip).toBe(`${GAME_FOLDER}\n${lines}`);
    });
  });

  it('reads the active profile, and a click switches profile', () => {
    const profile = row(new FakeInstance(VALUE), 'Profile');

    expect(profile.description).toBe('Survival');
    expect(profile.iconPath).toEqual(new ThemeIcon('account'));
    expect(profile.tooltip).toBe('Switch profile');
    expect(present(profile.command, 'the Profile row\'s command').command).toBe('modbench.profile.switch');
  });

  it.each([
    { holdsRepository: false, description: 'no repository' },
    { holdsRepository: true, description: 'repository' },
  ])('reads "$description" on the Modlist row while holdsRepository is $holdsRepository, and a click does nothing', ({ holdsRepository, description }) => {
    const modlist = row(new FakeInstance({ ...VALUE, holdsRepository }), 'Modlist');

    expect([modlist.description, modlist.iconPath, modlist.tooltip, modlist.contextValue, modlist.command])
      .toEqual([description, new ThemeIcon('source-control'), undefined, 'modlist', undefined]);
  });

  describe('the Deployment row', () => {
    const DEPLOYMENT = '/games/deployments/fo4-survival';

    it('reads the deployment folder\'s name and names the folder in its tooltip, a click opens the setting, and it is the deployment the Deployment menu keys on', () => {
      const deployment = row(new FakeInstance(VALUE), 'Deployment', new FakeDeploymentFolder(DEPLOYMENT));

      expect([deployment.description, deployment.iconPath, deployment.tooltip, deployment.command?.command, deployment.contextValue])
        .toEqual(['fo4-survival', new ThemeIcon('rocket'), DEPLOYMENT, 'modbench.settings.openDeploymentFolderHere', 'deployment']);
    });

    it('reads "no deployment folder" while the instance has none, and a click still opens the setting', () => {
      const deployment = row(new FakeInstance(VALUE), 'Deployment', new FakeDeploymentFolder());

      expect([deployment.description, deployment.tooltip, deployment.command?.command])
        .toEqual(['no deployment folder', undefined, 'modbench.settings.openDeploymentFolderHere']);
    });

    it('follows the setting', () => {
      const setting = new FakeDeploymentFolder();
      const provider = providerOf(new FakeInstance(VALUE), setting);
      const fired: unknown[] = [];
      provider.onDidChangeTreeData((e) => fired.push(e));

      setting.set(DEPLOYMENT);

      expect([fired, provider.getChildren().find((r) => r.label === 'Deployment')?.description]).toEqual([[undefined], 'fo4-survival']);
    });
  });

  it('marks the Profile row as the profile, which the Profile menu\'s `viewItem` clause keys on, so its menu offers switch', () => {
    expect(row(new FakeInstance(VALUE), 'Profile').contextValue).toBe('profile');
  });

  it('follows a landed value', () => {
    const instance = new FakeInstance(VALUE);
    const provider = providerOf(instance);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.publish(instanceValueFixture({ ...VALUE, activeProfile: 'Modding' }));

    expect(fired).toEqual([undefined]);
    expect(provider.getChildren().find((r) => r.label === 'Profile')?.description).toBe('Modding');
  });
});

describe('the Toolbox view, given a later read that fails', () => {
  it('keeps its rows, says it shows the last good read, and clears the line once a read lands', () => {
    const instance = new FakeInstance(VALUE);
    const provider = providerOf(instance);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('EACCES modlist.txt');

    expect(provider.getChildren().map((r) => r.label)).toEqual(['Game', 'Profile', 'Modlist', 'Deployment']);
    expect(provider.viewMessage()).toBe('Showing the last good read: EACCES modlist.txt');
    expect(fired).toHaveLength(1);
    instance.publish(VALUE);
    expect(provider.viewMessage()).toBeUndefined();
  });

  it('says nothing of a last good read while the first read has failed: the error row is the message', () => {
    const instance = new FakeInstance(VALUE, 0);
    const provider = providerOf(instance);

    instance.fail('ENOENT modlist.txt');

    expect(provider.viewMessage()).toBeUndefined();
  });
});

describe('the Toolbox view, while a gesture says its phase', () => {
  it('shows the gesture\'s message over the last good read\'s, announces the change, and gives the line back', () => {
    const instance = new FakeInstance(VALUE);
    const provider = providerOf(instance);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));
    instance.fail('EACCES modlist.txt');

    provider.say('Update manifest — reading the files of "ModA"…');
    const during = provider.viewMessage();
    provider.say(undefined);

    expect([during, provider.viewMessage(), fired.length]).toEqual(['Update manifest — reading the files of "ModA"…', 'Showing the last good read: EACCES modlist.txt', 3]);
  });
});

describe('the Toolbox view, given the game folder not found', () => {
  const NOT_FOUND = { ...VALUE, gameFolder: GAME_FOLDER_NOT_FOUND };

  it('keeps the game\'s name on the Game row, with a warning icon and "game folder not found"', () => {
    const game = row(new FakeInstance(NOT_FOUND), 'Game');

    expect(game.description).toBe('Fallout 4 · game folder not found');
    expect(game.iconPath).toEqual(new ThemeIcon('warning'));
    expect(game.command).toBeUndefined();
  });

  it('names each place Modbench looked, and the setting that fixes it, in the Game row\'s tooltip', () => {
    expect(row(new FakeInstance(NOT_FOUND), 'Game').tooltip).toBe([
      'Game folder not found. Modbench looked at:',
      'the game folder setting, modbench.mods.gameFolder: not set',
      "ModOrganizer.ini's gamePath: not set",
      'the Steam install: the game is in no Steam library',
      'Set modbench.mods.gameFolder to the game folder to fix it.',
    ].join('\n'));
  });

  it('keeps the Profile row, which does not need the game folder', () => {
    expect(row(new FakeInstance(NOT_FOUND), 'Profile').description).toBe('Survival');
  });

  it('clears the warning on the next value with the game folder found', () => {
    const instance = new FakeInstance(NOT_FOUND);
    const provider = providerOf(instance);

    instance.publish(VALUE);

    const game = present(provider.getChildren().find((r) => r.label === 'Game'), 'the Game row');
    expect(game.description).toBe('Fallout 4');
    expect(game.iconPath).toEqual(new ThemeIcon('game'));
    expect(game.tooltip).toBe(`${GAME_FOLDER}\nGame: 1.10.163.0\nScript extender: 0.0.6.23`);
  });
});

describe('the Toolbox view\'s states', () => {
  it('shows no rows where there is no instance to read', () => {
    expect(new ToolboxProvider({ instance: undefined }).getChildren()).toEqual([]);
  });

  it('shows no rows before the first read lands, rather than a Profile row reading the pre-read empty profile as `—`', () => {
    expect(rowsOf(new FakeInstance(instanceValueFixture({ activeProfile: '' }), 0))).toEqual([]);
  });

  it('shows one error row in place of its rows when the first read fails, and rows once a read lands', () => {
    const instance = new FakeInstance(VALUE, 0);
    const provider = providerOf(instance);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('ModOrganizer.ini names no profile');

    expect(fired).toEqual([undefined]);
    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    const error = present(rows[0], 'the error row');
    expect(error.label).toBe('Failed to load: ModOrganizer.ini names no profile');

    instance.publish(VALUE);

    expect(provider.getChildren().map((r) => r.label)).toEqual(['Game', 'Profile', 'Modlist', 'Deployment']);
  });

  it('stops following the instance once disposed', () => {
    const instance = new FakeInstance(VALUE);
    const provider = providerOf(instance);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    provider.dispose();
    instance.publish(VALUE);
    instance.fail('gone');

    expect(fired).toEqual([]);
  });
});
