import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { CompletionItemKind, document, host, Location, Range, Uri } from './vscodeHost';
import { instanceHolding, rowsOf, symbolsOver } from './symbolsOver';
import type { InstanceValue } from '../../instanceLoader/instance';
import { heldTexts, type HeldTexts, type PlaceInFile, type PlacedCopy, type PluginName, type PluginSymbol, type SymbolOwner, type SymbolReading } from '../../symbolNames/symbolNames';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const UNREAD = '/userlist.yaml: it does not read';

const namedAt = (line: number) => ({ place: { file: PLUGINS_TXT, start: { line, character: 1 }, end: { line, character: 9 } }, names: { name: 'Base.esm' } });
const plugin = (named: { name: string; origin?: string }) => ({ kind: 'plugin' as const, ...named });

const ownerThatCannotReadAFile: SymbolOwner = {
  read: () => Promise.resolve({ references: [namedAt(0)], leftOut: [UNREAD] }),
  nameAt: () => Promise.resolve({ name: 'Base.esm' }),
  plan: () => Promise.reject(new Error('Not planned here.')),
};

interface Options {
  owner?: SymbolOwner;
  plugins?: InstanceValue['plugins'];
  show?: (plugin: { name: string; origin: string }) => (() => Promise<void>) | undefined;
  tooltip?: (plugin: { name: string; origin: string }) => readonly string[];
}

function language({ owner = ownerThatCannotReadAFile, plugins = [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }], show = () => undefined, tooltip = () => [] }: Options = {}) {
  return symbolsOver({
    instance: instanceHolding(instanceValueFixture({ plugins })), owners: [owner], rows: rowsOf({ plugins: { show } }), pluginsShown: { tooltipLines: tooltip },
    arrange: (client) => { client.setQueryAnswer('getCopyDocument', null); client.setQueryAnswer('getRecordOwners', []); },
  });
}

const renamed = () => host.executed.filter(([id]) => id === 'modbench.plugin.rename');

describe('Rename Symbol on a plugin\'s name is the plugin\'s rename (symbols.md, The features, story 6)', () => {
  const MARKED = '*Mid.esp\r\n*bas|e.ESM\r\n';
  const naming = (name?: string) => language({ owner: { ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve(name === undefined ? undefined : { name }) } });

  it('renames the plugin mod order resolves the name to, with the name VS Code asked for', async () => {
    naming('base.ESM');

    await host.rename(PLUGINS_TXT, MARKED, 'New.esm');

    expect(renamed()).toEqual([['modbench.plugin.rename', undefined, undefined, { plugin: BASE, name: 'New.esm' }]]);
  });

  it('offers the name under the place, as the file spells it', async () => {
    naming('Base.esm');

    expect(await host.prepareRename(PLUGINS_TXT, MARKED)).toEqual({ spans: 'base.ESM', placeholder: 'base.ESM' });
  });

  it('offers nothing where no plugin\'s name is, and renames nothing a name resolves to no plugin', async () => {
    naming();
    await expect(host.prepareRename(PLUGINS_TXT, '*Go|ne.esp\r\n')).rejects.toThrow('Rename Symbol renames a plugin, a mod or a separator, or changes a record\'s FormKey or EditorID, and none is here.');
    await host.rename(PLUGINS_TXT, '*Go|ne.esp\r\n', 'New.esp');
    naming('Gone.esp');

    await expect(host.rename(PLUGINS_TXT, '*Go|ne.esp\r\n', 'New.esp')).rejects.toThrow('Mod order resolves Gone.esp to no plugin.');
    expect(renamed()).toEqual([]);
  });
});

const DATA = { name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm', line: null, enabled: true, winning: true };

describe('Rename Symbol on a plugin in the game folder', () => {
  it('is refused, saying it is no mod\'s plugin, and renames nothing', async () => {
    const owner: SymbolOwner = { ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve({ name: 'Fallout4.esm' }) };
    language({ owner, plugins: [DATA] });

    await expect(host.rename(PLUGINS_TXT, 'Fall|out4.esm\r\n', 'New.esm')).rejects.toThrow('Fallout4.esm is a plugin in the game folder, not in a mod: only a plugin in a mod renames.');
    expect(renamed()).toEqual([]);
  });
});

describe('referenced by on a plugin (commands.md, `referenced by` under Symbol)', () => {
  it('lists what names the plugin, titled with its row name, anchored at a place a file names it where no active plugin holds its header', async () => {
    language();
    host.holds([document(PLUGINS_TXT, '*Base.esm\r\n')]);

    await host.run('modbench.symbol.referencedBy', { argument: { kind: 'plugin', plugin: BASE } });

    expect(host.referencesShown).toEqual([expect.objectContaining({
      title: 'Referenced By: Base.esm (Base Mod)', contextValue: 'modbench.pluginReferencedBy', location: new Location(Uri.file(PLUGINS_TXT), new Range(0, 1, 0, 9)),
    })]);
  });
});

describe('a plugin\'s name, hover, completion and Go to Symbol (symbols.md, The features)', () => {
  const MID = { name: 'Mid.esp', origin: 'Mid Mod' };
  const rows = [BASE, { name: 'Base.esm', origin: 'Other Mod' }, MID].map((row, line) => ({ ...row, path: `/data/${row.name}`, line, enabled: true, winning: row.origin !== 'Other Mod' }));
  const naming = (name?: string, plugins: InstanceValue['plugins'] = rows) => language({
    plugins, owner: { ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve(name === undefined ? undefined : { name }) },
    tooltip: ({ name: file, origin }) => [file, origin, 'read-only'],
  });

  it('has the tooltip of the row of the plugin mod order resolves the name to', async () => {
    naming('base.ESM');

    expect(await host.hover(PLUGINS_TXT, '*Mid.esp\r\n*bas|e.ESM\r\n')).toEqual({ text: 'Base.esm\n\nBase Mod\n\nread-only', spans: 'base.ESM' });
  });

  it('is none where no plugin is named, so another kind may claim the place', async () => {
    naming();

    expect([await host.hover(PLUGINS_TXT, '*M|id.esp\r\n'), await host.complete(PLUGINS_TXT, '*M|id.esp\r\n')]).toEqual([undefined, undefined]);
  });

  it('has no tooltip when mod order resolves the name to no plugin', async () => {
    naming('Gone.esp');

    expect(await host.hover(PLUGINS_TXT, '*Go|ne.esp\r\n')).toEqual({ text: 'Gone.esp', spans: 'Gone.esp' });
  });

  it('completes where a file names a plugin with every plugin, over the name typed so far', async () => {
    naming('Ba');

    expect(await host.complete(PLUGINS_TXT, '*Ba|')).toEqual({
      isIncomplete: false,
      items: [
        { label: 'Base.esm', detail: 'Base Mod, Other Mod', kind: CompletionItemKind.File, insertText: undefined, replaces: 'Ba' },
        { label: 'Mid.esp', detail: 'Mid Mod', kind: CompletionItemKind.File, insertText: undefined, replaces: 'Ba' },
      ],
    });
  });

  const located = async (query: string) => (await host.workspaceSymbols(query)).map(({ name, containerName, location }) => [name, containerName, location]);

  it('lists each plugin copy whose name holds the query, whatever the case, at its file', async () => {
    naming();

    expect(await located('BASE')).toEqual([
      ['Base.esm', 'Base Mod', new Location(Uri.file('/data/Base.esm'), new Range(0, 0, 0, 0))],
      ['Base.esm', 'Other Mod', new Location(Uri.file('/data/Base.esm'), new Range(0, 0, 0, 0))],
    ]);
  });

  it('places a line that names no file at a place a file names it', async () => {
    naming(undefined, [{ ...BASE, path: undefined, line: 0, enabled: true, winning: true }]);

    expect(await located('base')).toEqual([['Base.esm', 'Base Mod', new Location(Uri.file(PLUGINS_TXT), new Range(0, 1, 0, 9))]]);
  });

  it('lists no plugin that has no file and that no file names', async () => {
    naming(undefined, [{ ...MID, path: undefined, line: 0, enabled: true, winning: true }]);

    expect(await located('mid')).toEqual([]);
  });
});

describe('where a plugin is defined, and the places files name it (symbols.md, The symbols, Plugin)', () => {
  const plugins = [
    { ...BASE, path: '/mods/Base Mod/Base.esm', line: 0, enabled: true, winning: true },
    { name: 'Base.esm', origin: 'Other Mod', path: '/mods/Other Mod/Base.esm', line: 1, enabled: true, winning: false },
    { name: 'Line.esp', origin: 'Base Mod', path: undefined, line: 2, enabled: true, winning: true },
  ];
  const indexed = () => language({ plugins, show: ({ origin }) => (origin === 'Shown Mod' ? () => Promise.resolve() : undefined) }).symbols;

  it('is its row in Plugins, where Plugins shows one', async () => {
    expect(await indexed().definitionOf(plugin({ name: 'Base.esm', origin: 'Shown Mod' }))).toEqual({ row: 'Plugins' });
  });

  it.each([
    ['the file of the copy its origin names', { name: 'Base.esm', origin: 'Other Mod' }, '/mods/Other Mod/Base.esm'],
    ['the file of the copy mod order resolves a file name alone to', { name: 'base.ESM' }, '/mods/Base Mod/Base.esm'],
  ])('is %s when Plugins shows no row for it', async (_case, named, path) => {
    expect(await indexed().definitionOf(plugin(named))).toEqual({ file: path });
  });

  it.each([
    ['a line whose file is not on disk', { name: 'Line.esp' }, 'Plugins shows no row for it and no file holds it.'],
    ['a name mod order resolves to no plugin', { name: 'Gone.esp' }, 'Mod order resolves Gone.esp to no plugin.'],
    ['an origin that holds none of the name', { name: 'Base.esm', origin: 'Gone Mod' }, 'The instance holds no plugin Base.esm from Gone Mod.'],
  ])('refuses %s', async (_case, named, refused) => {
    expect(await indexed().definitionOf(plugin(named))).toEqual({ refused });
  });

  it.each([
    ['a name mod order resolves to no plugin', { name: 'Gone.esp' }, 'Mod order resolves Gone.esp to no plugin.'],
    ['an origin that holds none of the name', { name: 'Base.esm', origin: 'Gone Mod' }, 'The instance holds no plugin Base.esm from Gone Mod.'],
  ])('refuses to list what names %s', async (_case, named, refused) => {
    expect(await indexed().referencesTo(plugin(named))).toEqual({ refused });
  });

  it('lists each place an owner reports, and each file it could not read', async () => {
    expect(await indexed().referencesTo(plugin({ name: 'Base.esm' }))).toEqual({
      references: [{ file: PLUGINS_TXT, start: { line: 0, character: 1 }, end: { line: 0, character: 9 } }], leftOut: [UNREAD],
    });
  });
});

describe('the plugins of the instance (ADR-0013)', () => {
  it('hold the plugins the game loads with no line beside the plugins with a line', async () => {
    symbolsOver({ instance: instanceHolding(instanceValueFixture({
      plugins: [{ name: 'Mod.esp', origin: 'Mod', path: '/Mod/Mod.esp', line: 0, enabled: true, winning: true }],
      pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
    })) });

    expect((await host.workspaceSymbols('.es')).map(({ name, containerName }) => [name, containerName])).toEqual([['Fallout4.esm', 'Data/'], ['Mod.esp', 'Mod']]);
  });
});

describe('Find All References on a plugin (symbols.md, The features, story 2)', () => {
  const BASE_LOSING = { name: 'Base.esm', origin: 'Old Base Mod' };
  const CHILD = { name: 'Child.esp', origin: 'Child Mod' };
  const PLUGINS = [{ ...BASE, winning: true }, { ...BASE_LOSING, winning: false }, { ...CHILD, winning: true }].map((row, line) => ({ ...row, path: `/data/${row.name}`, line, enabled: true }));
  const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
  const locationOfPlace = ({ file, start, end }: PlaceInFile) => new Location(Uri.file(file), new Range(start.line, start.character, end.line, end.character));
  const range = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 9 } });

  function owning(reading: SymbolReading, named: PluginName = BASE): SymbolOwner & { asked: [PluginSymbol, HeldTexts][] } {
    const asked: [PluginSymbol, HeldTexts][] = [];
    return { asked, read: (symbol, held) => { asked.push([symbol, held]); return Promise.resolve(reading); }, nameAt: () => Promise.resolve(named), plan: () => Promise.reject(new Error('Not planned here.')) };
  }
  const referencesTo = (owners: SymbolOwner[]) => {
    const made = symbolsOver({ instance: instanceHolding(instanceValueFixture({ plugins: PLUGINS })), owners });
    return { ...made, found: host.references(PLUGINS_TXT, '*Bas|e.esm\r\n') };
  };

  it('lists each place an owner reports that names the plugin, handing each owner the unsaved text', async () => {
    const owner = owning({ references: [{ place: place(PLUGINS_TXT, 1), names: { name: 'Base.esm' } }], leftOut: [] });
    const unsaved = document('/source/Child Mod/build.json', '{}', { isDirty: true });
    const { found } = referencesTo([owner]);
    host.holds([unsaved]);

    expect(await found).toEqual([locationOfPlace(place(PLUGINS_TXT, 1))]);
    expect(owner.asked.map(([{ name, origin }, held]) => [{ name, origin }, held])).toEqual([[BASE, heldTexts([['/source/Child Mod/build.json', '{}']])]]);
  });

  it('leaves out a name that names another copy: a file name alone names the copy mod order resolves it to', async () => {
    const owner = owning({ references: [
      { place: place(PLUGINS_TXT, 1), names: { name: 'Base.esm' } },
      { place: place('/source/Old Base Mod/build.json', 2), names: { name: 'Base.esm', origin: 'Old Base Mod' } },
    ], leftOut: [] }, BASE_LOSING);

    expect(await referencesTo([owner]).found).toEqual([locationOfPlace(place('/source/Old Base Mod/build.json', 2))]);
  });

  it('lists a copy at each range mEdit placed it, in its own file or its rendered document, and a master at its plugin\'s header (story 10)', async () => {
    const header: PlacedCopy = { formKey: '000000:Child.esp', plugin: CHILD, document: { kind: 'Rendered', location: 'Header.json' }, ranges: [range(0, 0)] };
    const npc: PlacedCopy = { formKey: '000800:Child.esp', plugin: CHILD, document: { kind: 'OwnFile', location: '/source/Child Mod/Npc.json' }, ranges: [range(1, 4), range(2, 4)] };

    expect(await referencesTo([owning({ references: [{ copy: header, names: { name: 'Base.esm' } }, { copy: npc, names: { name: 'Base.esm' } }], leftOut: [] })]).found).toEqual([
      new Location(Uri.from({ scheme: 'modbench-rendered', path: '/Child%20Mod/Child.esp/Header.json', query: 'formKey=000000%3AChild.esp&name=Child.esp&origin=Child+Mod' }), new Range(0, 0, 0, 9)),
      new Location(Uri.file('/source/Child Mod/Npc.json'), new Range(1, 4, 1, 13)),
      new Location(Uri.file('/source/Child Mod/Npc.json'), new Range(2, 4, 2, 13)),
    ]);
  });

  it('leaves out a placed copy whose name resolves to another copy', async () => {
    const copy: PlacedCopy = { formKey: '000800:Child.esp', plugin: CHILD, document: { kind: 'Rendered', location: 'Npc.json' }, ranges: [range(0, 0)] };

    expect(await referencesTo([owning({ references: [{ copy, names: { name: 'Base.esm' } }], leftOut: [] }, BASE_LOSING)]).found).toEqual([]);
  });

  it('says why a copy it could not place went unread only where the copy names the plugin asked of', async () => {
    const reading: SymbolReading = { references: [{ unread: '000800:Child.esp in Child.esp (Child Mod): its file is gone.', names: { name: 'Base.esm' } }], leftOut: [] };
    const unread = async (named: PluginName) => {
      const { found, reporter } = referencesTo([owning(reading, named)]);
      await found;
      return reporter.shownFailures.map(({ detail }) => detail);
    };

    expect([await unread(BASE), await unread(BASE_LOSING)]).toEqual([['000800:Child.esp in Child.esp (Child Mod): its file is gone.'], []]);
  });

  it('says why each file an owner could not read, or that threw, went unread (common.md, Reporting)', async () => {
    const { found, reporter } = referencesTo([
      owning({ references: [], leftOut: ['/userlist.yaml: it does not read'] }),
      { ...owning({ references: [], leftOut: [] }), read: () => Promise.reject(new Error('The disk is gone.')) },
    ]);

    expect(await found).toEqual([]);
    expect(reporter.shownFailures.map(({ message, detail }) => [message, detail])).toEqual([
      ['Find All References on Base.esm could not read a file that may name it.', '/userlist.yaml: it does not read'],
      ['Find All References on Base.esm could not read a file that may name it.', 'The disk is gone.'],
    ]);
  });
});
