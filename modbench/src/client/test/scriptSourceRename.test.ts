import { describe, expect, it, vi } from 'vitest';
import { scriptSourceRename } from '..';
import { heldTexts } from '../../symbolNames/symbolNames';
import { localFailure } from '../../wire/readFailed';

const MOD = { name: 'Mod.esp', origin: 'Mod' };
const CONTAINER = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const RENAMED = { documents: [{ path: CONTAINER, text: '{ "Name": "Ns:Renamed" }' }], plugins: [MOD], leftBehind: ['000801:Mod.esp in Other.esp (Other)'] };

type Answer = Awaited<ReturnType<Parameters<typeof scriptSourceRename>[0]['client']['getScriptRenameSourceChanges']>>;

async function planned(answer: Answer, refreshSourceControlFor = vi.fn()) {
  const getScriptRenameSourceChanges = vi.fn(() => Promise.resolve(answer));
  const plan = await scriptSourceRename({ client: { getScriptRenameSourceChanges }, refreshSourceControlFor })
    .plan({ kind: 'script', name: 'Ns:Quest' }, 'Ns:Renamed', heldTexts([]));
  if ('refused' in plan) throw new Error(plan.refused);
  return { plan, getScriptRenameSourceChanges };
}

describe('plugin source\'s part in renaming a Papyrus script (symbols.md, The features, stories 6 and 7)', () => {
  it('is mEdit\'s edit of each document that names it, and each reference it left behind', async () => {
    const { plan, getScriptRenameSourceChanges } = await planned(RENAMED);

    expect([plan.changes, plan.cannotFollow, getScriptRenameSourceChanges.mock.calls]).toEqual([
      { moves: [], deletions: [], documents: RENAMED.documents }, RENAMED.leftBehind, [['Ns:Quest', 'Ns:Renamed']],
    ]);
  });

  it('refreshes Source Control, once its edit applied, for each plugin whose source it edited', async () => {
    const refreshSourceControlFor = vi.fn();
    const { plan } = await planned(RENAMED, refreshSourceControlFor);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();

    await plan.commit();

    expect(refreshSourceControlFor.mock.calls).toEqual([[MOD]]);
  });

  it('edits nothing, and names what mEdit could not read, when mEdit cannot answer', async () => {
    const { plan } = await planned(localFailure('the record index is not ready'));

    expect([plan.changes.documents, plan.cannotFollow]).toEqual([[], ['the plugins mEdit reads: the record index is not ready']]);
  });
});
