import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { clientHoldingNothing, pluginsIndexedOver } from './pluginsOver';
import { recordSummaryFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import { READ_SORTING_RULE_FILES } from '../../test/readSortingRuleFiles';
import { present } from '../../ports/present';

const COMPILED = { isCompiledPlugin: true };
const MALFORMED = [['Mu.esp', 'ModE'], ['Nu.esp', 'ModC'], ['Xi.esp', 'Data/']];

type Named = 'alpha' | 'beta' | 'nonCompiledPlugin' | 'alsoNonCompiledPlugin' | 'inOverwrite' | 'compilable' | 'compiledPluginReadOnly'
  | 'nonCompiledPluginInSourceMod' | 'malformedInASourceMod' | 'malformedInNoSourceMod' | 'malformedInTheGameFolder' | 'moving' | 'locked'
  | 'weapons' | 'quests' | 'own' | 'immutable' | 'nonCompiledPluginRecord' | 'cell' | 'quest';

let rowsNamed: Record<Named, unknown>;

beforeAll(async () => {
  const malformed = clientHoldingNothing();
  malformed.setQueryAnswer('getDiagnoses', MALFORMED.map(([plugin, origin]) => ({ plugin, origin, text: 'short' })));
  const made = await pluginsIndexedOver([
    { name: 'Alpha.esp', origin: 'ModA' },
    { name: 'Beta.esp', origin: 'ModB', enabled: false },
    { name: 'Gamma.esp', origin: 'ModC' },
    { name: 'Zeta.esp', origin: 'ModZ' },
    { name: 'Eta.esp', origin: 'overwrite/' },
    { name: 'Eps.esp', origin: 'ModE', ...COMPILED },
    { name: 'Iota.esp', origin: 'ModI', ...COMPILED, isImmutable: true },
    { name: 'Kappa.esp', origin: 'ModE' },
    { name: 'Mu.esp', origin: 'ModE', ...COMPILED },
    { name: 'Nu.esp', origin: 'ModC' },
    { name: 'Xi.esp', origin: 'Data/' },
    { name: 'Mv.esp', origin: 'ModA' },
    { name: 'Last.esp', origin: 'ModA' },
  ], {
    client: malformed,
    value: {
      mods: ['ModA', 'ModB', 'ModC', 'ModZ', 'ModE', 'ModI'].map((name) => ({ kind: 'mod', name, enabled: true })),
      listedSourceMods: new Set(['ModE', 'ModI']),
      pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
      sortingRuleFiles: {
        ...READ_SORTING_RULE_FILES,
        userlist: { path: '/instance/loot/userlist.yaml', kind: 'text', text: "plugins:\n  - name: 'Mv.esp'\n    after: ['Last.esp']\n" },
      },
    },
  });
  const { client, rows, row } = made;
  client.setQueryAnswer('getRecordTypes', [
    recordTypeCountFixture({ type: 'weap', count: 3, displayName: 'Weapon' }),
    recordTypeCountFixture({ type: 'qust', count: 1, displayName: 'Quest', isCreatable: false }),
    recordTypeCountFixture({ type: 'wrld', count: 1, displayName: 'Worldspace' }),
  ]);
  client.setQueryAnswer('getWorldspaces', [{ formKey: '000805:Eps.esp', editorId: 'World', hasParseFailure: false, workingTreeState: 'None', hasChildren: true }]);
  client.setQueryAnswer('getWorldspaceBlocks', { blocks: [], topCells: [{
    formKey: '000803:Eps.esp', editorId: 'Cell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasChildren: false, fullName: null,
    hasParseFailure: false, workingTreeState: 'None',
  }] });
  const sole = async (parent: unknown) => present((await rows(parent))[0], 'a child row');
  const firstRecord = async (name: string, origin: string) => {
    client.setQueryAnswer('getRecords', { items: [recordSummaryFixture({ formKey: `000800:${name}`, plugin: name })], total: 1 });
    return sole(await sole(row(name, origin)));
  };
  const [weapons, quests, worlds] = await rows(row('Eps.esp', 'ModE'));
  rowsNamed = {
    alpha: row('Alpha.esp', 'ModA'),
    beta: row('Beta.esp', 'ModB'),
    nonCompiledPlugin: row('Gamma.esp', 'ModC'),
    alsoNonCompiledPlugin: row('Zeta.esp', 'ModZ'),
    inOverwrite: row('Eta.esp', 'overwrite/'),
    compilable: row('Eps.esp', 'ModE'),
    compiledPluginReadOnly: row('Iota.esp', 'ModI'),
    nonCompiledPluginInSourceMod: row('Kappa.esp', 'ModE'),
    malformedInASourceMod: row('Mu.esp', 'ModE'),
    malformedInNoSourceMod: row('Nu.esp', 'ModC'),
    malformedInTheGameFolder: row('Xi.esp', 'Data/'),
    moving: row('Mv.esp', 'ModA'),
    locked: row('Fallout4.esm', 'Data/'),
    weapons, quests,
    own: await firstRecord('Eps.esp', 'ModE'),
    quest: await sole(quests),
    cell: await sole(await sole(worlds)),
    immutable: await firstRecord('Iota.esp', 'ModI'),
    nonCompiledPluginRecord: await firstRecord('Beta.esp', 'ModB'),
  };
  await Promise.all(Object.values(rowsNamed).map(made.item));
  select = (names) => { made.view().selectRows(names.map((name) => rowsNamed[name])); };
});

let select: (names: readonly Named[]) => void;

const keyContext = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, host.context(`modbench.plugin.${key}`).at(-1)]));

type Case = [string, readonly Named[], Record<string, unknown>];
const reads = (_label: string, selection: readonly Named[], expected: Record<string, unknown>) => {
  select(selection);

  expect(keyContext(Object.keys(expected))).toEqual(expected);
};

describe('what the Plugins palette entries and keys read off the selection', () => {
  describe('reveal sees exactly one selected plugin, a locked one too', () => {
    it.each<Case>([
      ['one plugin', ['alpha'], { singlePlugin: true }],
      ['one locked plugin', ['locked'], { singlePlugin: true }],
      ['two plugins', ['alpha', 'beta'], { singlePlugin: false }],
      ['a record-type group', ['weapons'], { singlePlugin: false }],
    ])('%s', reads);
  });

  describe('version in git sees a selection of plugins in mods with no repository, every one', () => {
    it.each<Case>([
      ['two in mods with no repository', ['nonCompiledPlugin', 'alsoNonCompiledPlugin'], { allInNonSourceMod: true }],
      ['one beside a plugin in a source mod', ['nonCompiledPlugin', 'compilable'], { allInNonSourceMod: false }],
      ['nothing', [], { allInNonSourceMod: false }],
    ])('%s', reads);
  });

  describe('decompile sees a selection of plugins in source mods, every one', () => {
    it.each<Case>([
      ['compiled, read-only and source-less plugins of source mods', ['compilable', 'compiledPluginReadOnly', 'nonCompiledPluginInSourceMod'], { allInSourceMod: true }],
      ['one beside a plugin in a mod with no repository', ['compilable', 'nonCompiledPlugin'], { allInSourceMod: false }],
    ])('%s', reads);
  });

  describe('decompile and repair sees a selection of malformed plugins in mods, every one', () => {
    it.each<Case>([
      ['malformed plugins of a source mod and of a mod with no repository', ['malformedInASourceMod', 'malformedInNoSourceMod'], { allMalformedInAMod: true }],
      ['one beside a plugin not malformed', ['malformedInASourceMod', 'compilable'], { allMalformedInAMod: false }],
      ['a malformed plugin in the game folder', ['malformedInTheGameFolder'], { allMalformedInAMod: false }],
    ])('%s', reads);
  });

  describe('rename sees exactly one selected plugin in a mod, compiled or not', () => {
    it.each<Case>([
      ['a compiled plugin', ['compiledPluginReadOnly'], { singlePluginInMod: true }],
      ['a plugin in a mod that is no source mod', ['nonCompiledPlugin'], { singlePluginInMod: true }],
      ['a plugin in Overwrite', ['inOverwrite'], { singlePluginInMod: false }],
      ['a plugin the game loads with no line', ['locked'], { singlePluginInMod: false }],
      ['two plugins in mods', ['compilable', 'nonCompiledPlugin'], { singlePluginInMod: false }],
    ])('%s', reads);
  });

  describe('apply suggested move sees exactly one selected plugin that a broken rule moves', () => {
    it.each<Case>([
      ['a plugin a broken rule moves', ['moving'], { singleSuggestedMove: true }],
      ['a plugin no broken rule moves', ['compilable'], { singleSuggestedMove: false }],
      ['two plugins', ['moving', 'alpha'], { singleSuggestedMove: false }],
    ])('%s', reads);
  });

  describe('create sees exactly one selected record type, plugin or container that is a compiled plugin\'s and editable', () => {
    it.each<Case>([
      ['an editable group', ['weapons'], { singleCreatable: true }],
      ['an editable compiled plugin', ['compilable'], { singleCreatable: true }],
      ['a read-only compiled plugin', ['compiledPluginReadOnly'], { singleCreatable: false }],
      ['a group and a plugin', ['weapons', 'compilable'], { singleCreatable: false }],
      ['a record that is no container', ['own'], { singleCreatable: false }],
      ['an editable group of a type the game cannot create', ['quests'], { singleCreatable: false }],
      ['an editable container', ['quest'], { singleCreatable: true }],
      ['an editable cell', ['cell'], { singleCreatable: true }],
    ])('%s', reads);
  });

  describe('delete sees a selection of records, cells included, their plugins all let it remove', () => {
    it.each<Case>([
      ['a record and a cell of an editable plugin', ['own', 'cell'], { allDeletableRecords: true }],
      ['one beside a record of an immutable plugin', ['own', 'immutable'], { allDeletableRecords: false }],
      ['one beside a plugin', ['own', 'alpha'], { allDeletableRecords: false }],
    ])('%s', reads);
  });

  describe('copy sees a selection of records, cells included, whatever their plugins allow', () => {
    it.each<Case>([
      ['records of every plugin', ['own', 'cell', 'immutable', 'nonCompiledPluginRecord'], { allRecords: true }],
      ['one beside a plugin', ['own', 'alpha'], { allRecords: false }],
    ])('%s', reads);
  });

  describe('Space takes the first selected plugin\'s direction, as its line is now, and does nothing over no plugin', () => {
    it.each<Case>([
      ['an enabled plugin first', ['alpha', 'beta'], { selectionToggle: 'disable' }],
      ['a disabled plugin first', ['beta', 'alpha'], { selectionToggle: 'enable' }],
      ['a disabled plugin after a record', ['own', 'beta'], { selectionToggle: 'enable' }],
      ['a record and a locked plugin', ['own', 'locked'], { selectionToggle: undefined }],
    ])('%s', reads);
  });

  describe('enable sees a selection holding a plugin whose line is disabled now, disable one whose line is enabled', () => {
    it.each<Case>([
      ['an enabled and a disabled plugin', ['alpha', 'beta'], { holdsEnabledPlugin: true, holdsDisabledPlugin: true }],
      ['an enabled plugin', ['alpha'], { holdsEnabledPlugin: true, holdsDisabledPlugin: false }],
      ['a disabled plugin and a record', ['beta', 'own'], { holdsEnabledPlugin: false, holdsDisabledPlugin: true }],
      ['a record and a locked plugin', ['own', 'locked'], { holdsEnabledPlugin: false, holdsDisabledPlugin: false }],
    ])('%s', reads);
  });

  describe('move sees a selection holding a plugin with a plugins.txt line', () => {
    it.each<Case>([
      ['a plugin among a record and a locked plugin', ['own', 'locked', 'alpha'], { holdsPluginLine: true }],
      ['a record and a locked plugin', ['own', 'locked'], { holdsPluginLine: false }],
    ])('%s', reads);
  });
});
