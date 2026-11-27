import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { instanceHolding, sourceLanguageOver } from './sourceLanguageOver';
import type { GameFolder } from '../../instanceAdapter/instanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const FOUND: GameFolder = { kind: 'found', root: '/games/FO4', dataFolder: '/games/FO4/Data' };
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'gameFolder' };
const NOTICE = 'Paths are checked only against the instance, and scripts are not checked: the game also gets files from /games/FO4, outside the workspace.';
const STATUS = 'modbench.gameFolderOutside';

function fed(gameFolder: GameFolder, gameFolderInWorkspace: boolean) {
  const instance = instanceHolding(instanceValueFixture({ gameFolder, gameFolderInWorkspace }));
  sourceLanguageOver({ instance });
  return { land: (inWorkspace: boolean) => { instance.land(instanceValueFixture({ gameFolder, gameFolderInWorkspace: inWorkspace })); } };
}

describe('the language status for a game folder outside the workspace (source.md, Editing plugin source, story 1)', () => {
  it.each([
    ['says paths are checked only against the instance and scripts not at all, naming the game folder, for one outside the workspace', FOUND, false, NOTICE],
    ['says nothing for a game folder inside the workspace', FOUND, true, undefined],
    ['says nothing while no game folder is found', NOT_FOUND, false, undefined],
  ])('%s', (_case, gameFolder, gameFolderInWorkspace, text) => {
    fed(gameFolder, gameFolderInWorkspace);

    expect(host.status(STATUS)).toBe(text);
  });

  it.each([
    ['takes the game folder in', false, undefined],
    ['lets the game folder go', true, NOTICE],
  ])('follows the workspace when it %s', (_case, before, text) => {
    fed(FOUND, before).land(!before);

    expect(host.status(STATUS)).toBe(text);
  });
});
