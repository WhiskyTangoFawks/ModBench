import { describe, expect, it, vi } from 'vitest';
import { scriptRenameCommands } from '../renameScript';
import type { FileOrigin, FileSource, RenamedSymbol } from '../../instanceAdapter/instanceAdapter';
import { COMMITTED, heldTexts, type FileChanges } from '../../symbolNames/symbolNames';

type Held = Record<string, readonly string[]>;

const DATA = 'dataFolder';
const keyOf = (source: FileSource): string => (source.kind === 'mod' ? source.name : source.kind === 'dataFolder' ? DATA : 'Overwrite');
const WINNING: FileOrigin = { kind: 'mod', name: 'Winning' };
const LOSING: FileOrigin = { kind: 'mod', name: 'Losing' };
const CHANGES: FileChanges = { moves: [], deletions: [], documents: [{ path: '/source/Mod/plugin-source/Quest.json', text: 'renamed' }] };

const renamedAt = (origin: FileOrigin, path: string, to: { path: string; name?: string }): Extract<RenamedSymbol, { kind: 'script' }> =>
  ({ kind: 'script', origin, path, name: 'Quest', to });
const COMPILED = 'Scripts/Quest.pex';
const SOURCE = 'Scripts/Source/User/Quest.psc';

function renaming(held: Held) {
  const plan = vi.fn(() => Promise.resolve({ changes: CHANGES, cannotFollow: [], commit: () => Promise.resolve(COMMITTED) }));
  const applied: (readonly FileChanges[])[] = [];
  const { renameScript } = scriptRenameCommands({
    adapter: {
      gameRelease: () => Promise.resolve('Fallout4'),
      modOrder: () => Promise.resolve({
        mods: [{ kind: 'mod', name: 'Winning', enabled: true }, { kind: 'mod', name: 'Losing', enabled: true }, { kind: 'mod', name: 'Off', enabled: false }],
        modFolders: undefined,
      }),
      originHoldsFile: (source, path) => Promise.resolve((held[keyOf(source)] ?? []).some((each) => each.toLowerCase() === path.toLowerCase())),
    },
    client: { getScriptReferences: () => Promise.resolve({ copies: [{ formKey: '000801:Mod.esp', plugin: { name: 'Mod.esp', origin: 'Mod' }, inPluginSource: true, fieldPaths: [] }], unread: [] }) },
    references: { plan },
  });
  const editing = { held: heldTexts([]), apply: (changes: readonly FileChanges[]) => { applied.push(changes); return Promise.resolve(undefined); } };
  return { rename: (renamed: Extract<RenamedSymbol, { kind: 'script' }>) => renameScript(editing, renamed), plan, applied };
}

describe('a Papyrus script\'s file renamed from the Explorer (symbols.md, The features, stories 6, 7 and 9)', () => {
  it('carries the records that attach it when the renamed file is the only compiled script the game finds, its source left as it is', async () => {
    const { rename, plan, applied } = renaming({ Winning: [COMPILED, SOURCE] });

    expect(await rename(renamedAt(WINNING, COMPILED, { path: 'Scripts/Renamed.pex', name: 'Renamed' }))).toEqual({ applied: true, cannotFollow: [] });
    expect(plan).toHaveBeenCalledWith({ kind: 'script', name: 'Quest' }, 'Renamed', expect.anything());
    expect(applied).toEqual([[CHANGES]]);
  });

  it('carries them for a source when no copy of the script is compiled', async () => {
    const { rename } = renaming({ Winning: [SOURCE] });

    expect(await rename(renamedAt(WINNING, SOURCE, { path: 'Scripts/Source/User/Renamed.psc', name: 'Renamed' }))).toEqual({ applied: true, cannotFollow: [] });
  });

  it.each([
    ['the winning copy', { Winning: [COMPILED], Losing: [COMPILED] }, WINNING, COMPILED, 'Losing\'s Scripts/Quest.pex'],
    ['a losing copy', { Winning: [COMPILED], Losing: [COMPILED] }, LOSING, COMPILED, 'Winning\'s Scripts/Quest.pex'],
    ['a source whose compiled script stays', { Winning: [COMPILED, SOURCE] }, WINNING, SOURCE, 'Winning\'s Scripts/Quest.pex'],
    ['a copy the Data folder holds as well', { Winning: [COMPILED], [DATA]: [COMPILED] }, WINNING, COMPILED, 'the Data folder\'s Scripts/Quest.pex'],
  ])('carries no record for %s while the game still finds the script, saying where', async (_case, held: Held, origin, path, kept) => {
    const { rename, plan } = renaming(held);

    expect(await rename(renamedAt(origin, path, { path: 'Scripts/Renamed.pex', name: 'Renamed' }))).toEqual({
      applied: false, refusal: `the game still finds "Quest" at ${kept}.`,
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it('carries no record for a copy in a disabled mod', async () => {
    const { rename, plan } = renaming({ Off: [COMPILED] });

    expect(await rename(renamedAt({ kind: 'mod', name: 'Off' }, COMPILED, { path: 'Scripts/Renamed.pex', name: 'Renamed' }))).toEqual({
      applied: false, refusal: 'the game takes no "Quest" from Off, which is not enabled.',
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it('carries no record to a name another script already has, saying where', async () => {
    const { rename, plan } = renaming({ Winning: [COMPILED], Losing: ['Scripts/Source/User/Renamed.psc'] });

    expect(await rename(renamedAt(WINNING, COMPILED, { path: 'Scripts/Renamed.pex', name: 'Renamed' }))).toEqual({
      applied: false, refusal: '"Renamed" already names the Papyrus script at Losing\'s Scripts/Source/User/Renamed.psc.',
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it('counts the renamed file already at its new name as itself, and a new name differing in case alone as its own', async () => {
    const atNewName = renaming({ Winning: [COMPILED, 'Scripts/Renamed.pex'] });
    const inCase = renaming({ Winning: [COMPILED] });

    expect(await atNewName.rename(renamedAt(WINNING, COMPILED, { path: 'Scripts/Renamed.pex', name: 'Renamed' }))).toMatchObject({ applied: true });
    expect(await inCase.rename(renamedAt(WINNING, COMPILED, { path: 'Scripts/QUEST.pex', name: 'QUEST' }))).toMatchObject({ applied: true });
  });

  it('warns that a name that is no script\'s leaves each record that attaches it behind, naming them', async () => {
    const { rename, plan } = renaming({ Winning: [COMPILED] });

    expect(await rename(renamedAt(WINNING, COMPILED, { path: 'Scripts/Quest.pex.bak' }))).toEqual({
      applied: false, refusal: '"Quest.pex.bak" names no Papyrus script.', detail: '000801:Mod.esp in Mod.esp (Mod)',
    });
    expect(plan).not.toHaveBeenCalled();
  });
});
