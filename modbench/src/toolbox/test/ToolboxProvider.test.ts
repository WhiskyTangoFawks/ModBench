import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { ToolboxProvider } from '../ToolboxProvider';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';

const GAME_FOLDER = '/games/Fallout 4';
const VALUE = instanceValueFixture({
  activeProfile: 'Survival',
  gameRelease: 'Fallout 4',
  gameFolder: { kind: 'found', root: GAME_FOLDER, dataFolder: `${GAME_FOLDER}/Data` },
});

function rowsOf(instance: FakeInstance | undefined) {
  return new ToolboxProvider({ instance }).getChildren();
}

function row(instance: FakeInstance, label: string) {
  return present(rowsOf(instance).find((r) => r.label === label), `the ${label} row`);
}

describe('the Toolbox view, given an instance value', () => {
  it('shows a Game row, then a Profile row, and nothing else', () => {
    expect(rowsOf(new FakeInstance(VALUE)).map((r) => r.label)).toEqual(['Game', 'Profile']);
  });

  it('reads the game as MO2 names it, with the game folder in its tooltip and no click', () => {
    const game = row(new FakeInstance(VALUE), 'Game');

    expect(game.description).toBe('Fallout 4');
    expect(game.iconPath).toEqual(new ThemeIcon('game'));
    expect(game.tooltip).toBe(GAME_FOLDER);
    expect(game.command).toBeUndefined();
  });

  it('reads the active profile, and a click switches profile', () => {
    const profile = row(new FakeInstance(VALUE), 'Profile');

    expect(profile.description).toBe('Survival');
    expect(profile.iconPath).toEqual(new ThemeIcon('account'));
    expect(profile.tooltip).toBe('Switch profile');
    expect(present(profile.command, 'the Profile row\'s command').command).toBe('modbench.profile.switch');
  });

  it('marks the Profile row as the profile, which the Profile menu\'s `viewItem` clause keys on, so its menu offers switch', () => {
    expect(row(new FakeInstance(VALUE), 'Profile').contextValue).toBe('profile');
  });

  it('follows a landed value', () => {
    const instance = new FakeInstance(VALUE);
    const provider = new ToolboxProvider({ instance });
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
    const provider = new ToolboxProvider({ instance });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('EACCES modlist.txt');

    expect(provider.getChildren().map((r) => r.label)).toEqual(['Game', 'Profile']);
    expect(provider.viewMessage()).toBe('Showing the last good read: EACCES modlist.txt');
    expect(fired).toHaveLength(1);
    instance.publish(VALUE);
    expect(provider.viewMessage()).toBeUndefined();
  });

  it('says nothing of a last good read while the first read has failed: the error row is the message', () => {
    const instance = new FakeInstance(VALUE, 0);
    const provider = new ToolboxProvider({ instance });

    instance.fail('ENOENT modlist.txt');

    expect(provider.viewMessage()).toBeUndefined();
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
      'the game folder setting, modbench.mods.gameDirectory: not set',
      "ModOrganizer.ini's gamePath: not set",
      'the Steam install: the game is in no Steam library',
      'Set modbench.mods.gameDirectory to the game folder to fix it.',
    ].join('\n'));
  });

  it('keeps the Profile row, which does not need the game folder', () => {
    expect(row(new FakeInstance(NOT_FOUND), 'Profile').description).toBe('Survival');
  });

  it('clears the warning on the next value with the game folder found', () => {
    const instance = new FakeInstance(NOT_FOUND);
    const provider = new ToolboxProvider({ instance });

    instance.publish(VALUE);

    const game = present(provider.getChildren().find((r) => r.label === 'Game'), 'the Game row');
    expect(game.description).toBe('Fallout 4');
    expect(game.iconPath).toEqual(new ThemeIcon('game'));
    expect(game.tooltip).toBe(GAME_FOLDER);
  });
});

describe('the Toolbox view\'s states', () => {
  it('shows no rows where there is no instance to read', () => {
    expect(rowsOf(undefined)).toEqual([]);
  });

  it('shows no rows before the first read lands, rather than a Profile row reading the pre-read empty profile as `—`', () => {
    expect(rowsOf(new FakeInstance(instanceValueFixture({ activeProfile: '' }), 0))).toEqual([]);
  });

  it('shows one error row in place of its rows when the first read fails, and rows once a read lands', () => {
    const instance = new FakeInstance(VALUE, 0);
    const provider = new ToolboxProvider({ instance });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('ModOrganizer.ini names no profile');

    expect(fired).toEqual([undefined]);
    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    const error = present(rows[0], 'the error row');
    expect(error.label).toBe('Failed to load: ModOrganizer.ini names no profile');
    expect(error.tooltip).toBe('ModOrganizer.ini names no profile');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));

    instance.publish(VALUE);

    expect(provider.getChildren().map((r) => r.label)).toEqual(['Game', 'Profile']);
  });

  it('keeps its rows when a read after the first fails, the last good value standing', () => {
    const instance = new FakeInstance(VALUE);

    instance.fail('ModOrganizer.ini is torn');

    expect(rowsOf(instance).map((r) => r.label)).toEqual(['Game', 'Profile']);
  });

  it('stops following the instance once disposed', () => {
    const instance = new FakeInstance(VALUE);
    const provider = new ToolboxProvider({ instance });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    provider.dispose();
    instance.publish(VALUE);
    instance.fail('gone');

    expect(fired).toEqual([]);
  });
});
