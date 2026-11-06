import { describe, expect, it } from 'vitest';
import { heldTexts, type Planned } from '../../symbolNames/symbolNames';
import type { MEditClient } from '../MEditClient';
import { sourceFolderMove, type SourceFolderMoveOf } from '../sourceFolderMove';

type MoveClient = Pick<MEditClient, 'getSourceFolderMoveChanges' | 'followSourceFolderMove'>;

const MOD = { kind: 'mod', name: 'Old' } as const;
const MOVE = { from: '/instance/source/Old', to: '/instance/source/New', files: [{ from: 'Old.manifest.json', to: 'New.manifest.json' }] };
const MOVES = [{ from: MOVE.from, to: MOVE.to }, { from: '/instance/source/New/Old.manifest.json', to: '/instance/source/New/New.manifest.json' }];

function moveClient(answers: Partial<MoveClient> = {}): MoveClient & { asked: unknown[][]; followed: unknown[][] } {
  const asked: unknown[][] = [];
  const followed: unknown[][] = [];
  return {
    asked,
    followed,
    getSourceFolderMoveChanges: (...args) => { asked.push(args); return Promise.resolve({ moves: MOVES, deletions: [], documents: [] }); },
    followSourceFolderMove: (...args) => { followed.push(args); return Promise.resolve({ followed: true }); },
    ...answers,
  };
}

const moving: SourceFolderMoveOf = () => Promise.resolve(MOVE);

const plan = (client: MoveClient, moveOf: SourceFolderMoveOf = moving): Promise<Planned> => sourceFolderMove(client, moveOf).plan(MOD, 'New', heldTexts([]));

describe('a source mod\'s source folder moves with its mod, through mEdit\'s Source adapter', () => {
  it('plans the moves mEdit answers, and follows them in git once applied', async () => {
    const client = moveClient();

    const planned = await plan(client);
    if ('refused' in planned) throw new Error(planned.refused);

    expect([planned.changes, client.asked]).toEqual([{ moves: MOVES, deletions: [], documents: [] }, [[MOVE.from, MOVE.to, MOVE.files]]]);
    expect(client.followed).toEqual([]);
    expect(await planned.commit()).toEqual({ cannotFollow: [] });
    expect(client.followed).toEqual([[MOVE.from, MOVE.to]]);
  });

  it('refuses the rename when mEdit refuses the move', async () => {
    const client = moveClient({ getSourceFolderMoveChanges: () => Promise.resolve({ refused: true, message: "'/instance/source/New' is taken." }) });

    expect(await plan(client)).toEqual({ refused: "'/instance/source/New' is taken." });
  });

  it('lands, naming the folder git could not follow, when mEdit cannot follow the move', async () => {
    const planned = await plan(moveClient({ followSourceFolderMove: () => Promise.resolve({ refused: true, message: 'git is not on PATH.' }) }));
    if ('refused' in planned) throw new Error(planned.refused);

    expect(await planned.commit()).toEqual({ cannotFollow: [`${MOVE.to}: git is not on PATH.`] });
  });

  it('moves nothing for a mod with no source folder named for it', async () => {
    const client = moveClient();

    const planned = await plan(client, () => Promise.resolve(undefined));
    if ('refused' in planned) throw new Error(planned.refused);

    expect([planned.changes.moves, client.asked, await planned.commit(), client.followed]).toEqual([[], [], { cannotFollow: [] }, []]);
  });
});
