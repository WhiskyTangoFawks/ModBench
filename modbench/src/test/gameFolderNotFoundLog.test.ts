import { describe, it, expect } from 'vitest';
import { logGameFolderNotFound } from '../gameFolderNotFoundLog';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';

const FOUND = instanceValueFixture({ gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' } });
const NOT_FOUND = instanceValueFixture({ gameFolder: GAME_FOLDER_NOT_FOUND });

const LINE =
  'Game folder not found. Modbench looked at: the game folder setting, modbench.mods.gameDirectory: not set; ' +
  "ModOrganizer.ini's gamePath: not set; the Steam install: the game is in no Steam library. " +
  'Set modbench.mods.gameDirectory to the game folder to fix it.';

function logged(instance: FakeInstance): string[] {
  const lines: string[] = [];
  logGameFolderNotFound(instance, (line) => lines.push(line));
  return lines;
}

describe('the game folder not found, in the Output', () => {
  it('is one line naming each place Modbench looked and the setting that fixes it', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);

    instance.publish(NOT_FOUND);

    expect(lines).toEqual([LINE]);
  });

  // Rival: a line per landed value, which every watched file change would repeat.
  it('stays one line over every later value that still has no game folder', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);

    instance.publish(NOT_FOUND);
    instance.publish(instanceValueFixture({ ...NOT_FOUND, activeProfile: 'Survival' }));
    instance.publish(NOT_FOUND);

    expect(lines).toEqual([LINE]);
  });

  it('says nothing while the game folder is found', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);

    instance.publish(FOUND);

    expect(lines).toEqual([]);
  });

  // Rival: a flag set once and never cleared, which would hide the second failure.
  it('is a new line when the game folder is lost again after being found', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);

    instance.publish(NOT_FOUND);
    instance.publish(FOUND);
    instance.publish(NOT_FOUND);

    expect(lines).toEqual([LINE, LINE]);
  });

  it('is a new line when Modbench looked somewhere else and still found nothing', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);
    const elsewhere = instanceValueFixture({
      gameFolder: {
        kind: 'notFound', setting: 'modbench.mods.gameDirectory',
        looked: [{ place: 'the game folder setting, modbench.mods.gameDirectory', answer: '/moved has no Data folder' }],
      },
    });

    instance.publish(NOT_FOUND);
    instance.publish(elsewhere);

    expect(lines).toEqual([
      LINE,
      'Game folder not found. Modbench looked at: the game folder setting, modbench.mods.gameDirectory: ' +
        '/moved has no Data folder. Set modbench.mods.gameDirectory to the game folder to fix it.',
    ]);
  });
});
