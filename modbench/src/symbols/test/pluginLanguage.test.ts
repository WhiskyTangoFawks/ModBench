import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';
import { COMPLETION, SEARCH } from './fakeKinds';

const setInput = vi.hoisted(() => vi.fn<(input: ReferencesViewInput) => void>());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState, SymbolKind, CompletionItemKind,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { textDocuments: [], openTextDocument: () => Promise.resolve({ lineAt: () => ({ text: '*Base.esm' }) }) },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import { pluginLanguage } from '../pluginLanguage';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { PluginName, SymbolOwner } from '../../symbolNames/symbolNames';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';
import { recordingReporter } from '../../test/surfacingDoubles';
import { sourceNames } from './fakeSourceNames';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const UNREAD = '/userlist.yaml: it does not read';

const namedAt = (line: number, name = 'Base.esm') => ({ place: { file: PLUGINS_TXT, start: { line, character: 1 }, end: { line, character: 9 } }, names: { name } });
const plugin = (named: PluginName) => ({ kind: 'plugin' as const, ...named });

const ownerThatCannotReadAFile: SymbolOwner = {
  read: () => Promise.resolve({ references: [namedAt(0)], leftOut: [UNREAD] }),
  nameAt: () => Promise.resolve({ name: 'Base.esm' }),
  plan: () => Promise.reject(new Error('Not planned here.')),
};

interface Options {
  owner?: SymbolOwner;
  plugins?: InstanceValue['plugins'];
  loadedWithNoLine?: InstanceValue['pluginsLoadedWithNoLine'];
  show?: (plugin: { name: string; origin: string }) => (() => Promise<void>) | undefined;
  tooltip?: (plugin: { name: string; origin: string }) => readonly string[];
}

function language({ owner = ownerThatCannotReadAFile, plugins = [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }], loadedWithNoLine, show = () => undefined, tooltip = () => [] }: Options = {}) {
  const reporter = recordingReporter();
  const renamePlugin = vi.fn(() => Promise.resolve());
  const kind = pluginLanguage({
    instance: { value: { plugins, pluginsLoadedWithNoLine: loadedWithNoLine } },
    reporter,
    client: { getCopyDocument: () => Promise.resolve(null), getRecordOwners: () => Promise.resolve([]) },
    owners: [owner],
    names: sourceNames(),
    renamePlugin,
    rows: () => ({ show, fileOf: () => undefined }),
    tooltip,
  });
  return { kind, reporter, renamePlugin };
}

describe('Rename Symbol on a plugin\'s name is the plugin\'s rename (symbols.md, The features, story 6)', () => {
  const document = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Mid.esp\r\n*base.ESM\r\n' };
  const naming = (name?: string) => language({ owner: { ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve(name === undefined ? undefined : { name }) } });

  it('renames the plugin mod order resolves the name to, with the name VS Code asked for', async () => {
    const { kind, renamePlugin } = naming('base.ESM');

    expect(await kind.renameAt(document, 14, 'New.esm')).toBe(true);
    expect(renamePlugin).toHaveBeenCalledWith(BASE, 'New.esm');
  });

  it('offers the name under the place, as the file spells it', async () => {
    expect(await naming('Base.esm').kind.renameRangeAt(document, 14)).toEqual({ start: 11, end: 19, name: 'base.ESM' });
  });

  it('offers nothing where no plugin\'s name is, and renames nothing a name resolves to no plugin', async () => {
    const gone = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Gone.esp\r\n' };
    const { kind, renamePlugin } = naming('Gone.esp');

    expect(await naming().kind.renameRangeAt(gone, 3)).toBeUndefined();
    expect(await naming().kind.renameAt(gone, 3, 'New.esp')).toBe(false);
    await expect(kind.renameAt(gone, 3, 'New.esp')).rejects.toThrow('Mod order resolves Gone.esp to no plugin.');
    expect(renamePlugin).not.toHaveBeenCalled();
  });
});

describe('referenced by on a plugin (commands.md, `referenced by` under Symbol)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists what names the plugin, titled with its row name, anchored at a place a file names it where no active plugin holds its header', async () => {
    await language().kind.referencedBy({ kind: 'plugin', ...BASE });

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Referenced By: Base.esm (Base Mod)', contextValue: 'modbench.pluginReferencedBy', location: { uri: Uri.file(PLUGINS_TXT), range: new Range(0, 1, 0, 9) },
    }));
  });
});

describe('a plugin\'s name, hover, completion and Go to Symbol (symbols.md, The features)', () => {
  const MID = { name: 'Mid.esp', origin: 'Mid Mod' };
  const rows = [BASE, { name: 'Base.esm', origin: 'Other Mod' }, MID].map((row, line) => ({ ...row, path: `/data/${row.name}`, line, enabled: true, winning: row.origin !== 'Other Mod' }));
  const naming = (name?: string, plugins: InstanceValue['plugins'] = rows) => language({
    plugins, owner: { ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve(name === undefined ? undefined : { name }) },
    tooltip: ({ name: file, origin }) => [file, origin, 'read-only'],
  }).kind;
  const document = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Mid.esp\r\n*base.ESM\r\n' };

  it('spans the name under the place, as the file spells it', async () => {
    expect(await naming('base.ESM').nameAt(document, 14)).toEqual({ start: 11, end: 19, name: 'base.ESM', symbol: plugin({ name: 'base.ESM' }) });
  });

  it('is none where no plugin is named, so another kind may claim the place', async () => {
    expect([await naming().nameAt(document, 3), await naming().completionsAt(document, 3, COMPLETION)]).toEqual([undefined, undefined]);
  });

  it('has the tooltip of the row of the plugin mod order resolves the name to', async () => {
    expect(await naming().tooltipOf(plugin({ name: 'base.ESM' }))).toEqual(['Base.esm', 'Base Mod', 'read-only']);
  });

  it('has no tooltip when mod order resolves the name to no plugin', async () => {
    expect(await naming().tooltipOf(plugin({ name: 'Gone.esp' }))).toEqual([]);
  });

  it('completes where a file names a plugin with every plugin, over the name typed so far', async () => {
    const found = await naming('Ba').completionsAt({ uri: Uri.file(PLUGINS_TXT), getText: () => '*Ba' }, 3, COMPLETION);

    expect(found).toEqual({
      start: 1, end: 3, icon: CompletionItemKind.File,
      items: [{ label: 'Base.esm', detail: 'Base Mod, Other Mod' }, { label: 'Mid.esp', detail: 'Mid Mod' }],
    });
  });

  const located = (found: readonly { name: string; detail: string; location: unknown }[]) => found.map(({ name, detail, location }) => [name, detail, location]);

  it('lists each plugin copy whose name holds the query, whatever the case, at its file', async () => {
    const found = await naming().symbolsFor('BASE', SEARCH);

    expect(located(found)).toEqual([
      ['Base.esm', 'Base Mod', { uri: Uri.file('/data/Base.esm'), range: new Range(0, 0, 0, 0) }],
      ['Base.esm', 'Other Mod', { uri: Uri.file('/data/Base.esm'), range: new Range(0, 0, 0, 0) }],
    ]);
  });

  it('places a line that names no file at a place a file names it', async () => {
    const kind = naming(undefined, [{ ...BASE, path: undefined, line: 0, enabled: true, winning: true }]);

    expect(located(await kind.symbolsFor('base', SEARCH))).toEqual([['Base.esm', 'Base Mod', { uri: Uri.file(PLUGINS_TXT), range: new Range(0, 1, 0, 9) }]]);
  });

  it('lists no plugin that has no file and that no file names', async () => {
    expect(await naming(undefined, [{ ...MID, path: undefined, line: 0, enabled: true, winning: true }]).symbolsFor('mid', SEARCH)).toEqual([]);
  });
});

describe('where a plugin is defined, and the places files name it (symbols.md, The symbols, Plugin)', () => {
  const plugins = [
    { ...BASE, path: '/mods/Base Mod/Base.esm', line: 0, enabled: true, winning: true },
    { name: 'Base.esm', origin: 'Other Mod', path: '/mods/Other Mod/Base.esm', line: 1, enabled: true, winning: false },
    { name: 'Line.esp', origin: 'Base Mod', path: undefined, line: 2, enabled: true, winning: true },
  ];
  const showBase = vi.fn(() => Promise.resolve());
  const indexed = () => language({ plugins, show: ({ origin }) => (origin === 'Shown Mod' ? showBase : undefined) }).kind;

  it('is its row in Plugins, where Plugins shows one', async () => {
    expect(await indexed().definitionOf(plugin({ name: 'Base.esm', origin: 'Shown Mod' }))).toEqual({ row: 'Plugins', show: showBase });
  });

  it.each([
    ['the file of the copy its origin names', { name: 'Base.esm', origin: 'Other Mod' }, '/mods/Other Mod/Base.esm'],
    ['the file of the copy mod order resolves a file name alone to', { name: 'base.ESM' }, '/mods/Base Mod/Base.esm'],
  ])('is %s when Plugins shows no row for it', async (_case, named, path) => {
    expect(await indexed().definitionOf(plugin(named))).toEqual({ shown: { kind: 'loose', path } });
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
      locations: [{ uri: Uri.file(PLUGINS_TXT), range: new Range(0, 1, 0, 9) }], unread: [UNREAD],
    });
  });
});

describe('a plugin the game loads with no line (ADR-0013) is a plugin of the instance', () => {
  const DATA = { name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' };
  const owner: SymbolOwner = { ...ownerThatCannotReadAFile, read: () => Promise.resolve({ references: [namedAt(0, 'Fallout4.esm')], leftOut: [UNREAD] }) };
  const held = () => language({ owner, plugins: [], loadedWithNoLine: [DATA] }).kind;

  it.each([
    ['with its origin', { name: 'Fallout4.esm', origin: 'Data/' }],
    ['by its file name alone', { name: 'fallout4.esm' }],
  ])('lists what names it %s', async (_case, named) => {
    expect(await held().referencesTo(plugin(named))).toEqual({
      locations: [{ uri: Uri.file(PLUGINS_TXT), range: new Range(0, 1, 0, 9) }], unread: [UNREAD],
    });
  });
});
