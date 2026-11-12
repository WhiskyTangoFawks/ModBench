import { describe, expect, it } from 'vitest';
import { feedWorkspaceNotice } from '../workspaceNotice';
import type { GameFolder } from '../../instanceAdapter/instanceAdapter';

const found = (root: string): GameFolder => ({ kind: 'found', root, dataFolder: `${root}/Data` });
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'gameFolder' };

function fed(gameFolder: GameFolder, roots: string[]) {
  const shown: (string | undefined)[] = [];
  let value = { gameFolder };
  let landed = (): void => undefined;
  let moved = (): void => undefined;
  const stop = feedWorkspaceNotice({
    instance: { get value() { return value; }, subscribe: (listener) => { landed = listener; return { dispose: () => undefined }; } },
    workspaceRoots: () => roots,
    onWorkspaceChange: (listener) => { moved = listener; return { dispose: () => undefined }; },
    languageStatus: (text) => shown.push(text),
  });
  return { shown, stop, land: (next: GameFolder) => { value = { gameFolder: next }; landed(); }, move: (next: string[]) => { roots.splice(0, roots.length, ...next); moved(); } };
}

describe('the language status for a game folder outside the workspace (source.md, In the text editor, story 6)', () => {
  it('says paths are checked only against the instance, naming the game folder', () => {
    expect(fed(found('/games/FO4'), ['/instance']).shown).toEqual(['Paths are checked only against the instance: the game also gets files from /games/FO4, outside the workspace.']);
  });

  it('says nothing for a game folder inside the workspace', () => {
    expect(fed(found('/instance/game'), ['/instance']).shown).toEqual([undefined]);
  });

  it('says nothing while no game folder is found', () => {
    expect(fed(NOT_FOUND, ['/instance']).shown).toEqual([undefined]);
  });

  it('clears when the workspace takes the game folder in', () => {
    const { shown, move } = fed(found('/games/FO4'), ['/instance']);
    move(['/instance', '/games/FO4']);
    expect(shown.at(-1)).toBeUndefined();
  });

  it('follows the game folder the instance reads next', () => {
    const { shown, land } = fed(NOT_FOUND, ['/instance']);
    land(found('/games/FO4'));
    expect(shown.at(-1)).toContain('/games/FO4');
  });
});
