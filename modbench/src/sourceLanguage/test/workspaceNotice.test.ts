import { describe, expect, it } from 'vitest';
import { feedWorkspaceNotice } from '../workspaceNotice';
import type { GameFolder } from '../../instanceAdapter/instanceAdapter';

const FOUND: GameFolder = { kind: 'found', root: '/games/FO4', dataFolder: '/games/FO4/Data' };
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'gameFolder' };
const NOTICE = 'Paths are checked only against the instance: the game also gets files from /games/FO4, outside the workspace.';

function fed(value: { gameFolder: GameFolder; gameFolderInWorkspace: boolean }) {
  const shown: (string | undefined)[] = [];
  let land = (): void => undefined;
  const instance = { value, subscribe: (listener: () => void) => { land = listener; return { dispose: () => undefined }; } };
  feedWorkspaceNotice({ instance, languageStatus: (text) => shown.push(text) });
  return { shown, land: (next: typeof value) => { instance.value = next; land(); } };
}

describe('the language status for a game folder outside the workspace (source.md, In the text editor, story 6)', () => {
  it.each([
    ['says paths are checked only against the instance, naming the game folder, for one outside the workspace', FOUND, false, NOTICE],
    ['says nothing for a game folder inside the workspace', FOUND, true, undefined],
    ['says nothing while no game folder is found', NOT_FOUND, false, undefined],
  ])('%s', (_case, gameFolder, gameFolderInWorkspace, text) => {
    expect(fed({ gameFolder, gameFolderInWorkspace }).shown).toEqual([text]);
  });

  it.each([
    ['takes the game folder in', false, undefined],
    ['lets the game folder go', true, NOTICE],
  ])('follows the workspace when it %s', (_case, before, text) => {
    const { shown, land } = fed({ gameFolder: FOUND, gameFolderInWorkspace: before });
    land({ gameFolder: FOUND, gameFolderInWorkspace: !before });
    expect(shown.at(-1)).toBe(text);
  });
});
