import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { ToolboxProvider } from '../ToolboxProvider';
import { NO_DEPLOYMENT_FOLDER } from '../../test/noDeploymentFolder';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';

const FOUND = instanceValueFixture({ gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' } });
const NOT_FOUND = instanceValueFixture({ gameFolder: GAME_FOLDER_NOT_FOUND });

const LINE =
  '[instance] Game folder not found. Modbench looked at: the game folder setting, modbench.mods.gameFolder: not set; ' +
  "ModOrganizer.ini's gamePath: not set; the Steam install: the game is in no Steam library. " +
  'Set modbench.mods.gameFolder to the game folder to fix it.';

function logged(instance: FakeInstance): string[] {
  const lines: string[] = [];
  new ToolboxProvider({ instance, channel: { warn: (line) => lines.push(line) }, deploymentFolder: NO_DEPLOYMENT_FOLDER });
  return lines;
}

describe('the game folder not found, in the Output', () => {
  it('is one line naming each place Modbench looked and the setting that fixes it', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);

    instance.publish(NOT_FOUND);

    expect(lines).toEqual([LINE]);
  });

  it('says nothing while the game folder is found', () => {
    const instance = new FakeInstance(FOUND);
    const lines = logged(instance);

    instance.publish(FOUND);

    expect(lines).toEqual([]);
  });
});
