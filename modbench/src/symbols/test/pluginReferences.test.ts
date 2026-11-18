import { describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, TreeItem, TreeItemCollapsibleState, Range, Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} } }));

import { pluginReferencesOf } from '../pluginReferences';
import { heldTexts, type HeldTexts, type PlaceInFile, type PlacedCopy, type PluginSymbol, type SymbolOwner, type SymbolReading } from '../../symbolNames/symbolNames';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const BASE_LOSING = { name: 'Base.esm', origin: 'Old Base Mod' };
const CHILD = { name: 'Child.esp', origin: 'Child Mod' };
const plugins = [{ ...BASE, winning: true }, { ...BASE_LOSING, winning: false }, { ...CHILD, winning: true }];

const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
const locationOfPlace = ({ file, start, end }: PlaceInFile) => ({ uri: Uri.file(file), range: new Range(start.line, start.character, end.line, end.character) });
const range = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 9 } });

function fakeOwner(reading: SymbolReading): SymbolOwner & { asked: [PluginSymbol, HeldTexts][] } {
  const asked: [PluginSymbol, HeldTexts][] = [];
  return {
    asked,
    read: (symbol, held) => { asked.push([symbol, held]); return Promise.resolve(reading); },
    nameAt: () => Promise.resolve(undefined),
    plan: () => Promise.reject(new Error('Not planned here.')),
  };
}

function references(owners: SymbolOwner[]) {
  const held = heldTexts([['/source/Child Mod/build.json', '{}']]);
  return { referencesTo: pluginReferencesOf({ owners, plugins: () => plugins, held: () => held }), held };
}

describe('Find All References on a plugin (symbols.md, The features, story 2)', () => {
  it('lists each place an owner reports that names the plugin, handing each owner the unsaved text', async () => {
    const owner = fakeOwner({ references: [{ place: place(PLUGINS_TXT, 1), names: { name: 'Base.esm' } }], leftOut: [] });
    const { referencesTo, held } = references([owner]);

    expect(await referencesTo(BASE)).toEqual({ found: [locationOfPlace(place(PLUGINS_TXT, 1))], unread: [] });
    expect(owner.asked).toEqual([[BASE, held]]);
  });

  it('leaves out a name that names another copy: a file name alone names the copy mod order resolves it to', async () => {
    const owner = fakeOwner({ references: [
      { place: place(PLUGINS_TXT, 1), names: { name: 'Base.esm' } },
      { place: place('/source/Old Base Mod/build.json', 2), names: { name: 'Base.esm', origin: 'Old Base Mod' } },
    ], leftOut: [] });

    expect((await references([owner]).referencesTo(BASE_LOSING)).found).toEqual([locationOfPlace(place('/source/Old Base Mod/build.json', 2))]);
  });

  it('lists a copy at each range mEdit placed it, in its own file or its rendered document, and a master at its plugin\'s header (story 10)', async () => {
    const header: PlacedCopy = { formKey: '000000:Child.esp', plugin: CHILD, document: { kind: 'Rendered', location: 'Header.json' }, ranges: [range(0, 0)] };
    const npc: PlacedCopy = { formKey: '000800:Child.esp', plugin: CHILD, document: { kind: 'OwnFile', location: '/source/Child Mod/Npc.json' }, ranges: [range(1, 4), range(2, 4)] };
    const owner = fakeOwner({ references: [{ copy: header, names: { name: 'Base.esm' } }, { copy: npc, names: { name: 'Base.esm' } }], leftOut: [] });

    const { found } = await references([owner]).referencesTo(BASE);

    expect(found).toEqual([
      { uri: Uri.from({ scheme: 'modbench-rendered', path: '/Child%20Mod/Child.esp/Header.json', query: 'formKey=000000%3AChild.esp&name=Child.esp&origin=Child+Mod' }), range: new Range(0, 0, 0, 9) },
      { uri: Uri.file('/source/Child Mod/Npc.json'), range: new Range(1, 4, 1, 13) },
      { uri: Uri.file('/source/Child Mod/Npc.json'), range: new Range(2, 4, 2, 13) },
    ]);
  });

  it('leaves out a placed copy whose name resolves to another copy', async () => {
    const copy: PlacedCopy = { formKey: '000800:Child.esp', plugin: CHILD, document: { kind: 'Rendered', location: 'Npc.json' }, ranges: [range(0, 0)] };
    const owner = fakeOwner({ references: [{ copy, names: { name: 'Base.esm' } }], leftOut: [] });

    expect((await references([owner]).referencesTo(BASE_LOSING)).found).toEqual([]);
  });

  it('says why a copy it could not place went unread only where the copy names the plugin asked of', async () => {
    const owner = fakeOwner({ references: [{ unread: '000800:Child.esp in Child.esp (Child Mod): its file is gone.', names: { name: 'Base.esm' } }], leftOut: [] });

    expect([(await references([owner]).referencesTo(BASE)).unread, (await references([owner]).referencesTo(BASE_LOSING)).unread]).toEqual([
      ['000800:Child.esp in Child.esp (Child Mod): its file is gone.'], [],
    ]);
  });

  it('says why each file an owner could not read, or that threw, went unread (common.md, Reporting)', async () => {
    const { referencesTo } = references([
      fakeOwner({ references: [], leftOut: ['/userlist.yaml: it does not read'] }),
      { ...fakeOwner({ references: [], leftOut: [] }), read: () => Promise.reject(new Error('The disk is gone.')) },
    ]);

    expect(await referencesTo(BASE)).toEqual({ found: [], unread: ['/userlist.yaml: it does not read', 'The disk is gone.'] });
  });
});
