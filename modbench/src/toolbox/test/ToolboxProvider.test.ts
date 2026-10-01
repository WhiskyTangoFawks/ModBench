import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from '../../test/vscodeMock';

// The Toolbox renders the Instance's value and nothing else: no disk read, no backend state.
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
  return new ToolboxProvider({ instance, log: () => undefined }).getChildren();
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

  // The Profile menu's `viewItem` clause keys on this.
  it('marks the Profile row as the profile, so its menu offers switch', () => {
    expect(row(new FakeInstance(VALUE), 'Profile').contextValue).toBe('profile');
  });

  it('follows a landed value', () => {
    const instance = new FakeInstance(VALUE);
    const provider = new ToolboxProvider({ instance, log: () => undefined });
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
    const provider = new ToolboxProvider({ instance, log: () => undefined });
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
    const provider = new ToolboxProvider({ instance, log: () => undefined });

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
    const provider = new ToolboxProvider({ instance, log: () => undefined });

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

  // Rival: a Profile row reading the pre-first-read value's empty profile as `—`.
  it('shows no rows before the first read lands', () => {
    expect(rowsOf(new FakeInstance(instanceValueFixture({ activeProfile: '' }), 0))).toEqual([]);
  });

  it('shows one error row in place of its rows when the first read fails, and rows once a read lands', () => {
    const instance = new FakeInstance(VALUE, 0);
    const provider = new ToolboxProvider({ instance, log: () => undefined });
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

  // The last good value stands: a later failed read is not a first read.
  it('keeps its rows when a read after the first fails', () => {
    const instance = new FakeInstance(VALUE);

    instance.fail('ModOrganizer.ini is torn');

    expect(rowsOf(instance).map((r) => r.label)).toEqual(['Game', 'Profile']);
  });

  it('stops following the instance once disposed', () => {
    const instance = new FakeInstance(VALUE);
    const provider = new ToolboxProvider({ instance, log: () => undefined });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    provider.dispose();
    instance.publish(VALUE);
    instance.fail('gone');

    expect(fired).toEqual([]);
  });
});

describe('the Profile row and an unconfirmed switch (common.md, Unconfirmed writes)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const withProfile = (activeProfile: string) => instanceValueFixture({ ...VALUE, activeProfile });
  const profileOf = (provider: ToolboxProvider) => present(provider.getChildren().find((r) => r.label === 'Profile'), 'the Profile row');

  function toolbox(log: (line: string) => void = () => undefined) {
    const instance = new FakeInstance(withProfile('Survival'));
    return { instance, provider: new ToolboxProvider({ instance, log }) };
  }

  it('shows the picked profile at once, and the mark only after a delay', () => {
    const { provider } = toolbox();

    provider.markUnconfirmedProfile('Modding');

    expect(profileOf(provider).description).toBe('Modding');
    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('account'));

    vi.advanceTimersByTime(1000);
    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('sync~spin'));
    expect(profileOf(provider).tooltip).toBe('Written; waiting for the disk to confirm');
    expect(provider.getChildren().find((r) => r.label === 'Game')?.iconPath).toEqual(new ThemeIcon('game'));
  });

  it('goes silently when the disk shows the picked profile, and never flickers when that is at once', () => {
    const logged: string[] = [];
    const { instance, provider } = toolbox((line) => logged.push(line));
    provider.markUnconfirmedProfile('Modding');

    instance.publish(withProfile('Modding'));
    vi.advanceTimersByTime(1000);

    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('account'));
    expect(profileOf(provider).description).toBe('Modding');
    expect(logged).toEqual([]);
  });

  it('keeps the picked profile and the mark through a pre-write value, then clears silently on the confirming one', () => {
    const logged: string[] = [];
    const { instance, provider } = toolbox((line) => logged.push(line));
    provider.markUnconfirmedProfile('Modding');
    vi.advanceTimersByTime(1000);

    instance.publish(withProfile('Survival'));
    expect(profileOf(provider).description).toBe('Modding');
    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('sync~spin'));

    instance.publish(withProfile('Modding'));
    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('account'));
    expect(logged).toEqual([]);
  });

  it('shows the disk\'s profile and logs one line once a second landed value still differs', () => {
    const logged: string[] = [];
    const { instance, provider } = toolbox((line) => logged.push(line));
    provider.markUnconfirmedProfile('Modding');
    vi.advanceTimersByTime(1000);

    instance.publish(withProfile('Survival'));
    instance.publish(withProfile('Survival'));

    expect(profileOf(provider).description).toBe('Survival');
    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('account'));
    expect(logged).toEqual(['Profile "Modding" was selected, and the disk now shows "Survival".']);
  });

  it('stays while the disk cannot be read', () => {
    const { instance, provider } = toolbox();
    provider.markUnconfirmedProfile('Modding');
    vi.advanceTimersByTime(1000);

    instance.fail('locked');

    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('sync~spin'));
  });

  it('a switch forgotten shows the disk\'s profile at once, with no mark', () => {
    const { provider } = toolbox();
    provider.markUnconfirmedProfile('Modding');

    provider.forgetUnconfirmedProfile();
    vi.advanceTimersByTime(1000);

    expect(profileOf(provider).description).toBe('Survival');
    expect(profileOf(provider).iconPath).toEqual(new ThemeIcon('account'));
  });
});
