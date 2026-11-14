import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { renameSymbol } from '../renameSymbol';
import type { RecordMember } from '../sourceNames';
import { sourceNames } from './fakeSourceNames';

const SOURCE = '/instance/source/Patch Mod/plugin-source/Patch.esp/Npcs/PatchNpc - 000800_Patch.esp.json';
const TEXT = '{ "FormKey": "000800:Patch.esp", "EditorID": "PatchNpc", "Race": "000801:Base.esm", "Ref": "000802:Gone.esp", "Name": "Npc" }';
const at = (snippet: string) => TEXT.indexOf(snippet) + 2;
const between = (snippet: string) => ({ start: TEXT.indexOf(snippet), end: TEXT.indexOf(snippet) + snippet.length });
const PATCH = { name: 'Patch.esp', origin: 'Patch Mod' };
const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const PLUGINS = [{ ...BASE, winning: true }, { name: 'Base.esm', origin: 'Losing Mod', winning: false }];
const sourceDocument = { uri: { fsPath: SOURCE }, getText: () => TEXT };

const MEMBERS: Record<number, RecordMember> = {
  [at('000801')]: { ...between('000801:Base.esm'), formKey: '000801:Base.esm', member: 'FormKey', plugin: { name: 'Base.esm' } },
  [at('PatchNpc')]: { ...between('PatchNpc'), formKey: '000800:Patch.esp', member: 'EditorID' },
  [at('000802')]: { ...between('000802:Gone.esp'), formKey: '000802:Gone.esp', member: 'FormKey', plugin: { name: 'Gone.esp' } },
};

type FileAnswer = Awaited<ReturnType<Parameters<typeof renameSymbol>[0]['client']['getRecordOfFile']>>;

function renaming({ pluginNamed, file = { formKey: '000800:Patch.esp', plugin: PATCH } }: { pluginNamed?: string; file?: FileAnswer } = {}) {
  const executeCommand = vi.fn(() => Promise.resolve());
  const renameAt = vi.fn(() => Promise.resolve());
  const symbol = renameSymbol({
    plugin: { renameRangeAt: () => Promise.resolve(pluginNamed === undefined ? undefined : { start: 1, end: 9, name: pluginNamed }), renameAt },
    names: sourceNames({ recordMemberAt: (_file: string, _text: string, offset: number) => Promise.resolve(MEMBERS[offset]) }),
    plugins: () => PLUGINS,
    client: { getRecordOfFile: () => Promise.resolve(file) },
    executeCommand,
  });
  return { symbol, executeCommand, renameAt };
}

describe('Rename Symbol (symbols.md, The features, story 6)', () => {
  it('on a plugin\'s name, is the plugin\'s rename, before any record\'s edit', async () => {
    const { symbol, executeCommand, renameAt } = renaming({ pluginNamed: 'Base.esm' });

    expect(await symbol.prepare(sourceDocument, at('Base.esm'))).toEqual({ start: 1, end: 9, placeholder: 'Base.esm' });
    await symbol.rename(sourceDocument, at('Base.esm'), 'New.esm');

    expect(renameAt).toHaveBeenCalledWith(sourceDocument, at('Base.esm'), 'New.esm');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['a FormKey a record links, in the copy mod order resolves its plugin to', '000801', '000801:Base.esm', '000900:Base.esm',
      { formKey: '000801:Base.esm', plugin: 'Base.esm', origin: 'Base Mod' }, 'FormKey'],
    ['the EditorID, in the copy the file holds', 'PatchNpc', 'PatchNpc', 'Renamed',
      { formKey: '000800:Patch.esp', plugin: 'Patch.esp', origin: 'Patch Mod' }, 'EditorID'],
  ])('on %s, is edit field on it', async (_case, snippet, placeholder, newName, address, member) => {
    const { symbol, executeCommand } = renaming();

    const offered = await symbol.prepare(sourceDocument, at(snippet));
    await symbol.rename(sourceDocument, at(snippet), newName);

    expect(TEXT.slice(offered.start, offered.end)).toBe(placeholder);
    expect(offered.placeholder).toBe(placeholder);
    expect(executeCommand).toHaveBeenCalledWith('modbench.record.editField', address, { op: 'set', path: [{ kind: 'member', name: member }], value: newName });
  });

  it('offers nothing where plugin source names no FormKey or EditorID', async () => {
    await expect(renaming().symbol.prepare(sourceDocument, at('"Npc"'))).rejects.toThrow('Rename Symbol renames a plugin, or changes a record\'s FormKey or EditorID, and none is here.');
  });

  it.each([
    ['a FormKey whose plugin mod order resolves to no copy', '000802', 'Mod order resolves Gone.esp to no plugin.', undefined],
    ['an EditorID in a file that holds no record', 'PatchNpc', 'mEdit says this file holds no record.', null],
    ['an EditorID in a file mEdit cannot read', 'PatchNpc', 'mEdit could not be reached.', { failed: 'unreachable' } as const],
  ])('refuses %s, and edits nothing', async (_case, snippet, refusal, file) => {
    const { symbol, executeCommand } = renaming(file === undefined ? {} : { file });

    await expect(symbol.rename(sourceDocument, at(snippet), 'New')).rejects.toThrow(refusal);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
