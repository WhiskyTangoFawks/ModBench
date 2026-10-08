import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { present } from '../ports/present';
import { FOLDER_KEY, INSTANCE_READ_KEY } from '../drivingLib/folderContext';
import { IN_AN_INSTANCE, holds, isRecord, requires } from './manifest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString, uriFile, uriFrom,
} from './vscodeMock';

const groupOf = (entry: MenuEntry): string => (entry.group ?? '').split('@')[0] ?? '';
const orderOf = (entry: MenuEntry): number => Number((entry.group ?? '').split('@')[1] ?? Number.NaN);
const drawOrderKey = (group: string): string => (group === 'navigation' ? '' : group);
const placed = (entries: readonly MenuEntry[]): [string, string][] =>
  [...entries]
    .sort((a, b) => drawOrderKey(groupOf(a)).localeCompare(drawOrderKey(groupOf(b))) || orderOf(a) - orderOf(b))
    .map((e) => [e.command, groupOf(e)]);

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile, from: uriFrom },
}));

import { ModNode, NO_MODS_MESSAGE, OverwriteNode, SeparatorNode } from '../mods/ModListProvider';
import { CELL_VALUE_SETTING } from '../mods/conflictTableEditor';
import { CONFLICT_CELL_VALUES } from '../wire/conflictTable';
import { NO_PLUGINS_MESSAGE } from '../plugins/PluginsTreeProvider';
import { GREY_INACTIVE_FILES_SETTING } from '../mods/inactiveFiles';
import { indicatorSetting, MOD_INDICATORS } from '../mods/modIndicators';

interface ViewsWelcomeEntry { view: string; contents: string; when?: string; }
interface ViewEntry { id: string; name: string; when?: string; }
interface MenuEntry { command: string; when: string; group?: string; icon?: string; }
interface CommandEntry { command: string; title: string; category: string; icon?: string; }
interface KeybindingEntry { command: string; key: string; when: string; mac?: string; args?: unknown; }
interface ViewsContainerEntry { id: string; }
interface SettingEntry { description?: string; type?: unknown; default?: unknown; enum?: unknown; }
interface ColorEntry { id: string; }
interface CustomEditorEntry { viewType: string; }

interface PackageManifest {
  activationEvents: string[];
  contributes: {
    viewsWelcome: ViewsWelcomeEntry[];
    views: Record<string, ViewEntry[]>;
    viewsContainers: { panel: ViewsContainerEntry[] };
    menus: Record<string, MenuEntry[]>;
    commands: CommandEntry[];
    keybindings: KeybindingEntry[];
    configuration: { properties: Record<string, SettingEntry> };
    colors: ColorEntry[];
    customEditors: CustomEditorEntry[];
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
function isArrayOf<T>(value: unknown, isElement: (v: unknown) => v is T): value is T[] {
  return Array.isArray(value) && value.every(isElement);
}
function isRecordOf<T>(value: unknown, isElement: (v: unknown) => v is T): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(isElement);
}
function isRecordOfArrays<T>(value: unknown, isElement: (v: unknown) => v is T): value is Record<string, T[]> {
  return isRecord(value) && Object.values(value).every((v) => isArrayOf(v, isElement));
}

function isViewsWelcomeEntry(v: unknown): v is ViewsWelcomeEntry {
  return isRecord(v) && isString(v.view) && isString(v.contents) && isOptionalString(v.when);
}
function isViewEntry(v: unknown): v is ViewEntry {
  return isRecord(v) && isString(v.id) && isString(v.name) && isOptionalString(v.when);
}
function isMenuEntry(v: unknown): v is MenuEntry {
  return isRecord(v) && isString(v.command) && isString(v.when) && isOptionalString(v.group) && isOptionalString(v.icon);
}
function isCommandEntry(v: unknown): v is CommandEntry {
  return isRecord(v) && isString(v.command) && isString(v.title) && isString(v.category) && isOptionalString(v.icon);
}
function isKeybindingEntry(v: unknown): v is KeybindingEntry {
  return isRecord(v) && isString(v.command) && isString(v.key) && isString(v.when) && isOptionalString(v.mac);
}
function isViewsContainerEntry(v: unknown): v is ViewsContainerEntry {
  return isRecord(v) && isString(v.id);
}
function isSettingEntry(v: unknown): v is SettingEntry {
  return isRecord(v) && isOptionalString(v.description);
}
function isColorEntry(v: unknown): v is ColorEntry {
  return isRecord(v) && isString(v.id);
}
function isCustomEditorEntry(v: unknown): v is CustomEditorEntry {
  return isRecord(v) && isString(v.viewType);
}

function parsePackageManifest(raw: unknown): PackageManifest {
  if (!isRecord(raw) || !isArrayOf(raw.activationEvents, isString)) {
    throw new Error('Expected package.json to have a string[] activationEvents.');
  }
  const { contributes } = raw;
  if (!isRecord(contributes)) throw new Error('Expected package.json to have a contributes object.');
  const { viewsWelcome, views, viewsContainers, menus, commands, keybindings, configuration, colors, customEditors } = contributes;
  if (!isArrayOf(viewsWelcome, isViewsWelcomeEntry)) {
    throw new Error('Expected contributes.viewsWelcome to be an array of { view, contents, when? }.');
  }
  if (!isRecordOfArrays(views, isViewEntry)) {
    throw new Error('Expected contributes.views to be a map of { id, name, when? } arrays.');
  }
  if (!isRecord(viewsContainers) || !isArrayOf(viewsContainers.panel, isViewsContainerEntry)) {
    throw new Error('Expected contributes.viewsContainers.panel to be an array of { id }.');
  }
  if (!isRecordOfArrays(menus, isMenuEntry)) {
    throw new Error('Expected contributes.menus to be a map of { command, when, group?, icon? } arrays.');
  }
  if (!isArrayOf(commands, isCommandEntry)) {
    throw new Error('Expected contributes.commands to be an array of { command, title, category, icon? }.');
  }
  if (!isArrayOf(keybindings, isKeybindingEntry)) {
    throw new Error('Expected contributes.keybindings to be an array of { command, key, when }.');
  }
  if (!isRecord(configuration) || !isRecordOf(configuration.properties, isSettingEntry)) {
    throw new Error('Expected contributes.configuration.properties to be a map of { description? }.');
  }
  if (!isArrayOf(colors, isColorEntry)) throw new Error('Expected contributes.colors to be an array of { id }.');
  if (!isArrayOf(customEditors, isCustomEditorEntry)) throw new Error('Expected contributes.customEditors to be an array of { viewType }.');
  const { properties } = configuration;
  return {
    activationEvents: raw.activationEvents,
    contributes: {
      viewsWelcome, views, viewsContainers: { panel: viewsContainers.panel }, menus, commands, keybindings,
      configuration: { properties }, colors, customEditors,
    },
  };
}

const pkg = parsePackageManifest(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')),
);

type Context = Parameters<typeof holds>[1];
const inInstance: Context = { [FOLDER_KEY]: 'instance' };
type Key = { key: string; mac?: string; command: string };
const expectKeysFiring = (context: Context, expected: readonly Key[]): void => {
  const firing = pkg.contributes.keybindings.filter((k) => holds(k.when, context)).map(({ key, mac, command }) => ({ key, mac, command }));
  expect(firing).toHaveLength(expected.length);
  expect(firing).toEqual(expect.arrayContaining([...expected]));
};
const keysFiring = (context: Context): { key: string; mac?: string; command: string }[] =>
  pkg.contributes.keybindings.filter((k) => holds(k.when, context)).map(({ key, mac, command }) => ({ key, mac, command }));
const offeredIn = (entries: readonly MenuEntry[], context: Context): string[] =>
  placed(entries.filter((e) => holds(e.when, context))).map(([command]) => command);
const without = (facts: Context, fact: string): Context => Object.fromEntries(Object.entries(facts).filter(([key]) => key !== fact));
const eachMissingFact = (rows: readonly (readonly [string, Context])[]) =>
  rows.flatMap(([command, facts]) => Object.keys(facts).map((fact) => [command, fact, facts] as const));
const paletteOffers = (command: string, context: Context): boolean =>
  present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
    .filter((e) => e.command === command).some((e) => holds(e.when, context));

describe('package.json activation', () => {
  it('auto-activates on startup so the Activity Bar icon is never stuck hidden', () => {
    expect(pkg.activationEvents).toContain('onStartupFinished');
  });
});

describe('package.json outside an instance', () => {
  const isNotAnInstance = `${FOLDER_KEY} == notAnInstance`;
  const VIEWS_OF_THE_INSTANCE = ['modbench.toolbox', 'modbench.modList', 'modbench.pluginListTree', 'modbench.downloads'];

  it.each(VIEWS_OF_THE_INSTANCE)('%s says, once the check answers not an instance, that no instance is open and how to open one', (view) => {
    const notAnInstance = pkg.contributes.viewsWelcome.filter((w) => w.view === view && w.when === isNotAnInstance);
    expect(notAnInstance).toHaveLength(1);
    expect(present(notAnInstance[0], 'the not-an-instance welcome').contents).toContain('(command:vscode.openFolder)');
  });

  it('every view says it in the same words', () => {
    const contents = new Set(pkg.contributes.viewsWelcome.filter((w) => w.when === isNotAnInstance).map((w) => w.contents));
    expect(contents.size).toBe(1);
  });

  it('offers no title-bar gesture on any view until the check answers that the folder is an instance', () => {
    const titleMenus = present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
    expect(titleMenus.filter((e) => !requires(e.when, IN_AN_INSTANCE)).map((e) => e.command)).toEqual([]);
  });

  it('says "No downloads yet" only inside an instance, once its first read has landed, and never while all are excluded', () => {
    const empty = present(
      pkg.contributes.viewsWelcome.find((w) => w.view === 'modbench.downloads' && w.contents.startsWith('No downloads yet')),
      'the Downloads empty-list welcome',
    );
    expect(requires(empty.when, IN_AN_INSTANCE)).toBe(true);
    expect(requires(empty.when, INSTANCE_READ_KEY)).toBe(true);
    expect(requires(empty.when, '!modbench.downloadedFile.allExcluded')).toBe(true);
  });

  it('says files are excluded only inside an instance, and only while the all-excluded key is set', () => {
    const allExcluded = present(
      pkg.contributes.viewsWelcome.find((w) => w.view === 'modbench.downloads' && w.contents.toLowerCase().includes('excluded')),
      'the Downloads all-excluded welcome',
    );
    expect(allExcluded.contents.startsWith('No downloads yet')).toBe(false);
    expect(requires(allExcluded.when, IN_AN_INSTANCE)).toBe(true);
    expect(requires(allExcluded.when, INSTANCE_READ_KEY)).toBe(true);
    expect(requires(allExcluded.when, 'modbench.downloadedFile.allExcluded')).toBe(true);
  });

  it('binds no key to a command the palette offers only inside an instance, unless the key waits for one too', () => {
    const insideOnly = new Set(
      present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
        .filter((e) => requires(e.when, IN_AN_INSTANCE)).map((e) => e.command),
    );
    expect(insideOnly.size).toBeGreaterThan(0);
    const ungated = pkg.contributes.keybindings.filter((k) => insideOnly.has(k.command) && !requires(k.when, IN_AN_INSTANCE));
    expect(ungated.map((k) => `${k.key} → ${k.command}`)).toEqual([]);
  });

  it('recognizes the gate only as a top-level conjunct', () => {
    expect(requires(`view == modbench.modList && ${IN_AN_INSTANCE}`, IN_AN_INSTANCE)).toBe(true);
    expect(requires(`view == modbench.modList && !${IN_AN_INSTANCE}`, IN_AN_INSTANCE)).toBe(false);
    expect(requires(`view == modbench.modList || ${IN_AN_INSTANCE}`, IN_AN_INSTANCE)).toBe(false);
    expect(requires('view == modbench.modList', IN_AN_INSTANCE)).toBe(false);
  });

  it('recognizes the gate as a conjunct of every alternative', () => {
    expect(requires(`view == a && ${IN_AN_INSTANCE} || view == b && ${IN_AN_INSTANCE}`, IN_AN_INSTANCE)).toBe(true);
    expect(requires(`view == a && ${IN_AN_INSTANCE} || view == b`, IN_AN_INSTANCE)).toBe(false);
    expect(requires(undefined, IN_AN_INSTANCE)).toBe(false);
  });

  it('reads parentheses as VS Code groups them', () => {
    expect(requires(`${IN_AN_INSTANCE} && (view == a || view == b)`, IN_AN_INSTANCE)).toBe(true);
    expect(requires(`(view == a && ${IN_AN_INSTANCE}) || (view == b && ${IN_AN_INSTANCE})`, IN_AN_INSTANCE)).toBe(true);
    expect(requires(`(view == a || ${IN_AN_INSTANCE}) && view == b`, IN_AN_INSTANCE)).toBe(false);
    expect(requires(`!(${IN_AN_INSTANCE}) && view == a`, IN_AN_INSTANCE)).toBe(false);
    expect(requires(String.raw`${IN_AN_INSTANCE} && !(viewItem =~ /\b(a|b)\b/)`, IN_AN_INSTANCE)).toBe(true);
  });

  describe('holds', () => {
    const on = { view: 'modbench.pluginListTree', viewItem: 'plugin compilable' };

    it('needs every conjunct of an &&', () => {
      expect(holds(String.raw`view == modbench.pluginListTree && viewItem =~ /\bcompilable\b/`, on)).toBe(true);
      expect(holds(String.raw`view == modbench.pluginListTree && viewItem =~ /\buntrackedInMod\b/`, on)).toBe(false);
    });

    it('takes any alternative of an ||', () => {
      expect(holds('viewItem == other || view == modbench.pluginListTree', on)).toBe(true);
      expect(holds('viewItem == other || view == other', on)).toBe(false);
    });

    it('inverts what follows a !, a parenthesised group included', () => {
      expect(holds(String.raw`view == modbench.pluginListTree && !(viewItem =~ /\bcompilable\b/)`, on)).toBe(false);
      expect(holds(String.raw`view == modbench.pluginListTree && !(viewItem =~ /\buntrackedInMod\b/)`, on)).toBe(true);
      expect(holds('!compilable', {})).toBe(true);
      expect(holds('!compilable', { compilable: true })).toBe(false);
    });

    it('binds && tighter than ||, and lets parentheses regroup', () => {
      expect(holds('view == other && viewItem == other || viewItem == plugin compilable', on)).toBe(true);
      expect(holds('view == other && (viewItem == other || viewItem == plugin compilable)', on)).toBe(false);
    });
  });

  it('evaluates a clause against the context it is given', () => {
    const on = { view: 'modbench.pluginListTree', viewItem: 'plugin compilable' };
    expect(holds('view == modbench.pluginListTree && (viewItem == plugin || viewItem == other)', { ...on, viewItem: 'plugin' })).toBe(true);
    expect(holds("webviewId == 'modbench' && compilable", { webviewId: 'modbench', compilable: true })).toBe(true);
    expect(holds("webviewId == 'modbench' && compilable", { webviewId: 'modbench' })).toBe(false);
  });

  it('refuses a clause it cannot read, rather than reading it as ungated', () => {
    expect(() => requires(`${IN_AN_INSTANCE} && (view == a`, IN_AN_INSTANCE)).toThrow(/cannot read/);
    expect(() => requires(`${IN_AN_INSTANCE} && view == a)`, IN_AN_INSTANCE)).toThrow(/cannot read/);
  });
});

describe('package.json Referenced By view container', () => {
  it('lives in a Panel-location viewsContainer, not stacked under the modbench activity-bar container', () => {
    const panel: { id: string }[] = pkg.contributes.viewsContainers.panel;
    const panelContainerIds = new Set(panel.map((c) => c.id));
    const views: Record<string, { id: string }[]> = pkg.contributes.views;
    const referencedByContainer = present(
      Object.entries(views).find(([, entries]) => entries.some((v) => v.id === 'modbench.referencedByTree'))?.[0],
      'a views entry for modbench.referencedByTree',
    );

    expect(panelContainerIds.has(referencedByContainer)).toBe(true);

    const sidebarViews = present(pkg.contributes.views.modbench, "contributes.views['modbench']");
    expect(sidebarViews.some((v) => v.id === 'modbench.referencedByTree')).toBe(false);
  });
});

describe('package.json Toolbox view', () => {
  const sidebarViews = (): ViewEntry[] => present(pkg.contributes.views.modbench, "contributes.views['modbench']");

  it('is the first view in the Modbench container, so workspace-scope actions sit above the domain trees', () => {
    expect(present(sidebarViews()[0], 'the first view of the Modbench container').id).toBe('modbench.toolbox');
  });

  it('has refresh as its one title icon and open settings in its title bar\'s overflow', () => {
    const toolboxTitle = present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']")
      .filter((e) => requires(e.when, 'view == modbench.toolbox'));

    expect(toolboxTitle.map((e) => ({ command: e.command, icon: (e.group ?? '').startsWith('navigation') })))
      .toEqual([
        { command: 'modbench.instance.refresh', icon: true },
        { command: 'modbench.settings.open', icon: false },
      ]);
  });

  it('offers switch, and only switch, on the Profile row\'s menu', () => {
    const profileMenu = present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => requires(e.when, 'view == modbench.toolbox') && requires(e.when, 'viewItem == profile'));

    expect(profileMenu.map((e) => e.command)).toEqual(['modbench.profile.switch']);
  });
});

describe('package.json Referenced By view', () => {
  const view = (): ViewEntry => present(
    present(pkg.contributes.views.modbenchReferencedBy, "contributes.views['modbenchReferencedBy']")
      .find((v) => v.id === 'modbench.referencedByTree'),
    'the modbench.referencedByTree view entry',
  );

  it('names the Referenced By view "Referenced By", the title xEdit gives its tab', () => {
    expect(view().name).toBe('Referenced By');
  });

  it('carries no gate at all — always present, like Mods/Plugins/Downloads', () => {
    expect(view().when).toBeUndefined();
  });
});

describe('package.json Referenced By title bar', () => {
  const REFERENCED_BY_VIEW = 'view == modbench.referencedByTree';
  const titleBar = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']").filter((e) => requires(e.when, REFERENCED_BY_VIEW));

  it('offers filter or clear, then sort direction, as icons', () => {
    expect(placed(titleBar())).toEqual([
      ['modbench.referencedByTree.filterHere', 'navigation'],
      ['modbench.referencedByTree.clearFilterHere', 'navigation'],
      ['modbench.referrer.sortDescending', 'navigation'],
      ['modbench.referrer.sortAscending', 'navigation'],
    ]);
    expect(titleBar().map((e) => e.group)).toEqual(['navigation@1', 'navigation@1', 'navigation@2', 'navigation@2']);
  });

  it.each([
    [{}, ['modbench.referencedByTree.filterHere', 'modbench.referrer.sortDescending']],
    [{ 'modbench.referrer.descending': true }, ['modbench.referencedByTree.filterHere', 'modbench.referrer.sortAscending']],
    [{ 'modbench.referrer.filterActive': true }, ['modbench.referencedByTree.clearFilterHere', 'modbench.referrer.sortDescending']],
  ])('with %j the title bar shows one filter control and the one direction the list is not in', (facts, commands) => {
    expect(offeredIn(titleBar(), { view: 'modbench.referencedByTree', ...inInstance, ...facts })).toEqual(commands);
  });
});

describe('package.json New Plugin / record filter reachable from the merged tree', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const entryFor = (command: string) =>
    present(
      titleMenus().find((e) => e.command === command && requires(e.when, 'view == modbench.pluginListTree')),
      `a view/title entry for ${command} on modbench.pluginListTree`,
    );

  it('keeps the Plugins name filter at slot 1', () => {
    expect(entryFor('modbench.pluginListTree.filterHere').group).toBe('navigation@1');
  });

  it('shows filter records at slot 3, and the clear in its place while the record filter is active', () => {
    const filter = entryFor('modbench.record.filter');
    const clear = entryFor('modbench.record.clearFilter');
    expect(filter.group).toBe('navigation@3');
    expect(clear.group).toBe('navigation@3');
  });

  it('places create plugin at slot 4', () => {
    expect(entryFor('modbench.plugin.create').group).toBe('navigation@4');
  });

  it('offers the record filter pair in no menu but the view title and the palette', () => {
    const menus: Record<string, MenuEntry[]> = pkg.contributes.menus;
    const elsewhere = Object.entries(menus)
      .filter(([menu]) => menu !== 'view/title' && menu !== 'commandPalette')
      .flatMap(([menu, entries]) => entries
        .filter((e) => e.command === 'modbench.record.filter' || e.command === 'modbench.record.clearFilter')
        .map((e) => `${menu}: ${e.command}`));
    expect(elsewhere).toEqual([]);
  });

  it('gates the pair\'s palette entries to an instance', () => {
    const palette = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']");
    for (const command of ['modbench.record.filter', 'modbench.record.clearFilter']) {
      const entry = present(palette.find((e) => e.command === command), `a commandPalette entry for ${command}`);
      expect(requires(entry.when, IN_AN_INSTANCE)).toBe(true);
    }
  });

  it('gates create plugin\'s palette entry to an instance', () => {
    const palette = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']");
    const entry = present(
      palette.find((e) => e.command === 'modbench.plugin.create'),
      'a commandPalette entry for modbench.plugin.create',
    );
    expect(requires(entry.when, IN_AN_INSTANCE)).toBe(true);
  });
});

describe('package.json filtering is one UX', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const commandOf = (): CommandEntry[] => pkg.contributes.commands;
  const commandTitle = (id: string) =>
    present(commandOf().find((c) => c.command === id), `a command entry for ${id}`);

  const FILTERED_VIEWS = [
    ['modbench.modList', 'modbench.modList.filterHere'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filterHere'],
    ['modbench.downloads', 'modbench.downloads.filterHere'],
    ['modbench.referencedByTree', 'modbench.referencedByTree.filterHere'],
  ] as const;

  it.each(FILTERED_VIEWS)('%s narrows by name from slot 1', (view, command) => {
    const entry = present(
      titleMenus().find((e) => e.command === command && requires(e.when, `view == ${view}`)),
      `${command} on ${view}`,
    );
    expect(entry.group).toBe('navigation@1');
  });

  it.each(FILTERED_VIEWS)('%s uses $(search) — narrowing by name, not by condition', (_view, command) => {
    expect(commandTitle(command).icon).toBe('$(search)');
  });

  it('keeps $(filter) for the record filter, so the two never read as the same action', () => {
    expect(commandTitle('modbench.record.filter').icon).toBe('$(filter)');
  });

  it('clears the record filter with $(clear-all), as every durable filter clears', () => {
    expect(commandTitle('modbench.record.clearFilter').icon).toBe('$(clear-all)');
  });

  const OTHER_DURABLE_FILTERS = [
    ['modbench.modList', 'modbench.modList.filterHere', 'modbench.modList.clearFilterHere', 'modbench.mod.filterActive'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filterHere', 'modbench.pluginListTree.clearFilterHere', 'modbench.plugin.filterActive'],
    ['modbench.referencedByTree', 'modbench.referencedByTree.filterHere', 'modbench.referencedByTree.clearFilterHere', 'modbench.referrer.filterActive'],
  ] as const;
  const DOWNLOADS_FILTER = ['modbench.downloads', 'modbench.downloads.filterHere', 'modbench.downloads.clearFilterHere', 'modbench.downloadedFile.filterActive'] as const;
  const entryOn = (view: string, command: string): MenuEntry => present(
    titleMenus().find((e) => e.command === command && requires(e.when, `view == ${view}`)),
    `${command} on ${view}`,
  );

  it.each(OTHER_DURABLE_FILTERS)('%s swaps slot 1 to its clear variant while a filter is active', (view, open, clearCommand, key) => {
    const idle = { view, ...inInstance };
    const filtering = { ...idle, [key]: true };
    expect(holds(entryOn(view, open).when, idle)).toBe(true);
    expect(holds(entryOn(view, clearCommand).when, idle)).toBe(false);
    expect(holds(entryOn(view, open).when, filtering)).toBe(false);
    expect(holds(entryOn(view, clearCommand).when, filtering)).toBe(true);
    expect(entryOn(view, clearCommand).group).toBe('navigation@1');
  });

  it('Downloads swaps slot 1 to its clear variant on its filter-active key, in an instance', () => {
    const [view, open, clearCommand, key] = DOWNLOADS_FILTER;
    expect(requires(entryOn(view, open).when, `!${key}`)).toBe(true);
    expect(requires(entryOn(view, clearCommand).when, key)).toBe(true);
    expect(requires(entryOn(view, clearCommand).when, IN_AN_INSTANCE)).toBe(true);
    expect(entryOn(view, clearCommand).group).toBe('navigation@1');
  });

  it.each([...OTHER_DURABLE_FILTERS, DOWNLOADS_FILTER])('%s clears with $(clear-all)', (_view, _open, clearCommand) => {
    expect(commandTitle(clearCommand).icon).toBe('$(clear-all)');
  });
});

describe('package.json Refresh is one command', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");

  it('declares exactly one refresh command', () => {
    const refreshCommands = pkg.contributes.commands.filter((c) => c.icon === '$(refresh)');
    expect(refreshCommands.map((c) => c.command)).toEqual(['modbench.instance.refresh']);
  });

  it('puts it at slot 1 of the Toolbox and nowhere else', () => {
    const entries = titleMenus().filter((e) => e.command === 'modbench.instance.refresh');
    expect(entries).toHaveLength(1);
    const entry = present(entries[0], 'the sole modbench.instance.refresh view/title entry');
    expect(holds(entry.when, { view: 'modbench.toolbox', ...inInstance })).toBe(true);
    expect(holds(entry.when, { view: 'modbench.toolbox' })).toBe(false);
    expect(entry.group).toBe('navigation@1');
  });

});

describe('package.json title-bar rubric', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const viewsOf = (entries: MenuEntry[]) =>
    new Set(entries.map((e) => /view == ([\w.]+)/.exec(e.when)?.[1]).filter((v): v is string => v !== undefined));

  const WORKSPACE_ACTIONS = ['modbench.profile.switch'];

  it.each(WORKSPACE_ACTIONS)('%s is absent from every domain tree title bar', (command) => {
    const domainViews = [...viewsOf(titleMenus())].filter((v) => v !== 'modbench.toolbox');
    expect(domainViews.filter((v) => titleMenus().some((e) => e.command === command && requires(e.when, `view == ${v}`)))).toEqual([]);
  });

  const navEntries = titleMenus().filter((e) => (e.group ?? '').startsWith('navigation'));
  const facts = (entries: MenuEntry[]): string[] => [...new Set(entries.flatMap((e) => e.when.match(/modbench\.[\w.]+/g) ?? []))]
    .filter((key) => !key.startsWith('modbench.folder') && !viewsOf(navEntries).has(key));
  const statesOf = (keys: string[]): Context[] => keys.reduce<Context[]>(
    (states, key) => states.flatMap((state) => [state, { ...state, [key]: true }]), [{}]);

  it.each([...viewsOf(navEntries)])('%s never exposes more than four navigation icons, in any state', (view) => {
    const entries = navEntries.filter((e) => requires(e.when, `view == ${view}`));
    const visible = statesOf(facts(entries)).map((state) => entries.filter((e) => holds(e.when, { view, ...inInstance, ...state })).length);
    expect(Math.max(...visible), `${view} exposes too many navigation icons`).toBeLessThanOrEqual(4);
  });

  it('the Mods tree and the merged Plugins tree are in the Modbench sidebar', () => {
    const sidebarIds = present(pkg.contributes.views.modbench, "contributes.views['modbench']");
    const sidebar = sidebarIds.map((v) => v.id);
    expect(sidebar).toContain('modbench.modList');
    expect(sidebar).toContain('modbench.pluginListTree');
  });
});

describe('package.json contributes the conflict table\'s cell value as a setting (mods-conflicts.md, Cells)', () => {
  it('a choice of the values the table can show, the size by default', () => {
    expect(pkg.contributes.configuration.properties[CELL_VALUE_SETTING]).toMatchObject({
      type: 'string', enum: [...CONFLICT_CELL_VALUES], default: 'size',
    });
  });
});

describe('package.json contributes the Mods view\'s indicators and grey as settings (mods.md, Indicators)', () => {
  const { properties } = pkg.contributes.configuration;

  it('the grey of a file the game does not get: a switch, on by default, under the key the grey reads', () => {
    expect(properties[GREY_INACTIVE_FILES_SETTING]).toMatchObject({ type: 'boolean', default: true });
  });

  it('a switch for each indicator\'s badge and colour, under the keys they read, defaulting as the table says', () => {
    const switches = Object.fromEntries(MOD_INDICATORS.flatMap(({ id }) => (['badge', 'colour'] as const)
      .map((part) => [`${id} ${part}`, properties[indicatorSetting(id, part)]?.type === 'boolean' && properties[indicatorSetting(id, part)]?.default]))) as unknown;

    expect(switches).toEqual({
      'overwritesLooseFiles badge': false, 'overwritesLooseFiles colour': false,
      'overwrittenLooseFiles badge': true, 'overwrittenLooseFiles colour': false,
      'redundant badge': true, 'redundant colour': false,
      'containsExcludedFiles badge': false, 'containsExcludedFiles colour': false,
    });
  });

  it('a theme colour for each indicator', () => {
    const contributed = pkg.contributes.colors.map((colour) => colour.id);
    expect(MOD_INDICATORS.filter(({ colour }) => !contributed.includes(colour)).map(({ id }) => id)).toEqual([]);
  });
});

describe('package.json command titles and categories', () => {
  const commands = pkg.contributes.commands;
  const palette = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']");

  it('no title carries the hardcoded "Modbench: " palette prefix — category supplies it instead', () => {
    const offenders = commands.filter((c) => c.title.startsWith('Modbench: '));
    expect(offenders.map((c) => c.command)).toEqual([]);
  });

  it('every modbench.* command declares category "Modbench", independent of palette visibility', () => {
    const offenders = commands.filter((c) => c.category !== 'Modbench');
    expect(offenders.map((c) => c.command)).toEqual([]);
  });

  const gatedFalse = (): Set<string> => new Set(palette.filter((e) => e.when === 'false').map((e) => e.command));

  it('gates only the system commands and the entry points out of the palette', () => {
    const unexpectedGate = [...gatedFalse()].filter((c) => !(INTERNAL_COMMANDS as readonly string[]).includes(c) && !ENTRY_POINTS.includes(c));
    expect(unexpectedGate).toEqual([]);
  });

  it('offers every catalog gesture in the palette', () => {
    const gestureIds = catalogCommandIds(commandsMarkdown.slice(0, commandsMarkdown.indexOf('## System commands')));
    const declared = new Set(commands.map((c) => c.command));
    const hidden = [...gestureIds].filter((id) => gatedFalse().has(id) || !declared.has(id));
    expect(
      hidden,
      'commands.md, Entry points are not gestures: every gesture is also in the command palette.',
    ).toEqual([]);
  });

  const INTERNAL_COMMANDS = [
    'modbench.instance.putLoadOrder',
    'modbench.mod.sync',
    'modbench.plugin.sync',
  ] as const;

  it('gates every entry point out of the palette too', () => {
    expect(ENTRY_POINTS.filter((c) => !gatedFalse().has(c))).toEqual([]);
  });

  it('gates every internal system command out of the palette too', () => {
    const systemCommandIds = catalogCommandIds(commandsMarkdown.slice(commandsMarkdown.indexOf('## System commands')));
    const notASystemCommand = INTERNAL_COMMANDS.filter((c) => !systemCommandIds.has(c));
    expect(
      notASystemCommand,
      notASystemCommand.map((c) => `${c} is not a Command ID in commands.md's System commands table.`).join('\n'),
    ).toEqual([]);
    const missingGate = INTERNAL_COMMANDS.filter((c) => !gatedFalse().has(c));
    expect(missingGate).toEqual([]);
  });
});

describe('package.json Plugins menus, keys and palette follow plugins.md', () => {
  const PLUGINS_VIEW = 'view == modbench.pluginListTree';
  const inPluginsView = (menu: string): MenuEntry[] =>
    present(pkg.contributes.menus[menu], `contributes.menus['${menu}']`).filter((e) => requires(e.when, PLUGINS_VIEW));
  const menuOf = (contextValue: string): [string, string][] => placed(
    inPluginsView('view/item/context').filter((e) => holds(e.when, { view: 'modbench.pluginListTree', viewItem: contextValue })));

  it('title bar: filter or clear, sort direction, filter records or clear, then create plugin, as icons, with Collapse All left to VS Code', () => {
    expect(inPluginsView('view/title').map((e) => [e.command, e.group])).toEqual(expect.arrayContaining([
      ['modbench.plugin.sortWinningAtTop', 'navigation@2'],
      ['modbench.plugin.sortLosingAtTop', 'navigation@2'],
    ]));
    expect(placed(inPluginsView('view/title'))).toEqual([
      ['modbench.pluginListTree.filterHere', 'navigation'],
      ['modbench.pluginListTree.clearFilterHere', 'navigation'],
      ['modbench.plugin.sortWinningAtTop', 'navigation'],
      ['modbench.plugin.sortLosingAtTop', 'navigation'],
      ['modbench.record.filter', 'navigation'],
      ['modbench.record.clearFilter', 'navigation'],
      ['modbench.plugin.create', 'navigation'],
    ]);
  });

  it.each([
    [{}, ['modbench.pluginListTree.filterHere', 'modbench.plugin.sortWinningAtTop', 'modbench.record.filter', 'modbench.plugin.create']],
    [{ 'modbench.plugin.winningAtTop': true }, ['modbench.pluginListTree.filterHere', 'modbench.plugin.sortLosingAtTop', 'modbench.record.filter', 'modbench.plugin.create']],
    [{ 'modbench.plugin.filterActive': true }, ['modbench.pluginListTree.clearFilterHere', 'modbench.plugin.sortWinningAtTop', 'modbench.record.filter', 'modbench.plugin.create']],
    [{ 'modbench.record.filterActive': true }, ['modbench.pluginListTree.filterHere', 'modbench.plugin.sortWinningAtTop', 'modbench.record.clearFilter', 'modbench.plugin.create']],
  ])('title bar with %j: one filter control, the one direction the view is not in, one record filter control, create plugin', (facts, commands) => {
    expect(offeredIn(inPluginsView('view/title'), { view: 'modbench.pluginListTree', ...inInstance, ...facts })).toEqual(commands);
  });

  it('the empty list\'s message names the title bar\'s create plugin', () => {
    const create = present(pkg.contributes.commands.find((c) => c.command === 'modbench.plugin.create'), 'create plugin');
    expect(NO_PLUGINS_MESSAGE).toContain(create.title);
    expect(NO_PLUGINS_MESSAGE).toContain('title bar');
  });

  it('plugin menu: reveal, enable or disable, rename, create record, track, decompile, compile, copy value', () => {
    expect(menuOf('plugin disabled inUntrackedMod untracked editable')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.enable', '2_change'],
      ['modbench.mod.track', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
    expect(menuOf('plugin enabled inTrackedMod tracked editable')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.plugin.rename', '2_change'],
      ['modbench.record.create', '3_create'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.plugin.compile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('plugin menu on a disabled tracked plugin: rename, decompile and compile, and no record edit', () => {
    expect(menuOf('plugin disabled inTrackedMod tracked')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.enable', '2_change'],
      ['modbench.plugin.rename', '2_change'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.plugin.compile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('plugin menu on a plugin whose plugin source is unreadable: rename, decompile and compile, and no record edit', () => {
    expect(menuOf('plugin enabled inTrackedMod tracked')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.plugin.rename', '2_change'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.plugin.compile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('plugin menu on an untracked plugin in a tracked mod: decompile, and neither track nor compile', () => {
    expect(menuOf('plugin enabled inTrackedMod untracked editable')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('plugin menu on a plugin in a mod with no repository that mEdit has not described: track', () => {
    expect(menuOf('plugin enabled inUntrackedMod')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.mod.track', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('plugin menu: enable and disable share one slot', () => {
    const slotOf = (command: string) =>
      present(inPluginsView('view/item/context').find((e) => e.command === command), command).group;
    expect(slotOf('modbench.plugin.enable')).toBe(slotOf('modbench.plugin.disable'));
  });

  it.each([
    ['in Overwrite', 'plugin enabled inOverwrite untracked editable'],
    ['in the game folder', 'plugin enabled untracked editable'],
  ])('plugin menu on a plugin %s: neither track, decompile, create record nor compile', (_what, contextValue) => {
    expect(menuOf(contextValue)).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('the locked row: reveal and copy value', () => {
    expect(menuOf('pluginImplicit')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('record-type group menu: create record, only where its plugin is tracked, editable and the type is creatable', () => {
    expect(menuOf('recordType tracked editable creatable')).toEqual([['modbench.record.create', '3_create']]);
    expect(menuOf('recordType untracked editable creatable')).toEqual([]);
    expect(menuOf('recordType tracked creatable')).toEqual([]);
    expect(menuOf('recordType tracked editable')).toEqual([]);
  });

  it.each(['record', 'worldspace', 'cell', 'placed'])(
    'record menu on a %s row: open to the side, copy, copy value, then delete last', (kind) => {
      expect(menuOf(`${kind} tracked editable`)).toEqual([
        [OPEN_TO_THE_SIDE, '1_open'],
        ['modbench.record.copy', '5_copy'],
        ['modbench.copyValue', '5_copy'],
        ['modbench.record.delete', '6_destroy'],
      ]);
    });

  it.each(['record', 'worldspace', 'cell'])(
    'record menu on a %s row that is a container: create record between open and copy', (kind) => {
      expect(menuOf(`${kind} tracked editable container`)).toEqual([
        [OPEN_TO_THE_SIDE, '1_open'],
        ['modbench.record.create', '3_create'],
        ['modbench.record.copy', '5_copy'],
        ['modbench.copyValue', '5_copy'],
        ['modbench.record.delete', '6_destroy'],
      ]);
    });

  it.each([['untracked', 'untracked editable'], ['read-only', 'tracked']])('record menu on a container whose plugin is %s: no create record', (_what, conditions) => {
    expect(menuOf(`record ${conditions} container`).map(([command]) => command)).not.toContain('modbench.record.create');
  });

  it.each([['untracked', 'untracked editable'], ['read-only', 'tracked']])('record menu on a record whose plugin is %s: no delete', (_what, conditions) => {
    expect(menuOf(`record ${conditions}`)).toEqual([
      [OPEN_TO_THE_SIDE, '1_open'],
      ['modbench.record.copy', '5_copy'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it.each(['recordType tracked editable', 'block', 'subBlock', 'placedGroup-persistent', 'indexing', 'error'])(
    'offers no record gesture on a row that stands for no record: %s', (contextValue) => {
      const recordGestures = menuOf(contextValue).filter(([command]) => command !== 'modbench.record.create');
      expect(recordGestures).toEqual([]);
    });

  const COPY = { key: 'ctrl+c', mac: 'cmd+c', command: 'modbench.copyValue' };

  it.each([
    [{}, []],
    [{ 'modbench.plugin.selectionToggle': 'enable' }, [{ key: 'space', command: 'modbench.plugin.enable' }]],
    [{ 'modbench.plugin.selectionToggle': 'disable' }, [{ key: 'space', command: 'modbench.plugin.disable' }]],
    [{ 'modbench.plugin.singleTracked': true }, [{ key: 'f2', command: 'modbench.plugin.rename' }]],
    [{ 'modbench.plugin.allDeletableRecords': true }, [{ key: 'Delete', mac: 'cmd+backspace', command: 'modbench.record.delete' }]],
  ])('on the focused Plugins tree with %j, the keys that fire are those of the commands the selection allows, and copy value', (facts, keys) => {
    expectKeysFiring({ focusedView: 'modbench.pluginListTree', listFocus: true, ...inInstance, ...facts }, [...keys, COPY]);
  });
});

describe('package.json Downloads row menu order', () => {
  const DOWNLOAD_ROW = String.raw`viewItem =~ /\bdownload\b/`;
  const EXCLUDED_ROW = String.raw`viewItem =~ /\bexcluded\b/`;
  const downloadRowMenu = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => requires(e.when, 'view == modbench.downloads') && requires(e.when, DOWNLOAD_ROW));
  const entryFor = (command: string): MenuEntry =>
    present(downloadRowMenu().find((e) => e.command === command), `a ${command} row-menu entry`);

  it.each([
    ['modbench.mod.viewOnNexus', String.raw`viewItem =~ /\bhasModID\b/`],
    ['modbench.downloadedFile.openMeta', String.raw`viewItem =~ /\bhasMeta\b/`],
    ['modbench.downloadedFile.exclude', `!${EXCLUDED_ROW}`],
    ['modbench.downloadedFile.include', EXCLUDED_ROW],
  ])('%s waits for the flag the row carries: %s', (command, term) => {
    expect(requires(entryFor(command).when, term)).toBe(true);
  });

  it('orders the row in strictly increasing slots: install, view on Nexus, open, open .meta, exclude/include sharing one, copy value, delete', () => {
    const entries = downloadRowMenu();
    const slotOf = (command: string): number => {
      const group = present(entries.find((e) => e.command === command), `a ${command} row-menu entry`).group ?? '';
      return Number(present(/@(\d+)$/.exec(group)?.[1], `a numbered group for ${command} (got "${group}")`));
    };
    const exclude = slotOf('modbench.downloadedFile.exclude');
    const include = slotOf('modbench.downloadedFile.include');
    expect(include).toBe(exclude);

    const slots = [
      'modbench.mod.install', 'modbench.mod.viewOnNexus', 'modbench.downloadedFile.open',
      'modbench.downloadedFile.openMeta', 'modbench.downloadedFile.exclude', 'modbench.copyValue',
      'modbench.downloadedFile.delete',
    ].map(slotOf);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe('package.json view keys', () => {
  const VIEW_SCOPES = ['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads', 'modbench.referencedByTree']
    .map((view) => `focusedView == ${view}`);
  const RECORD_TAB_SCOPE = "activeCustomEditorId == 'modbench.record'";
  const ON_THE_TREE = ['listFocus', '!inputFocus'];

  it('scopes every key to a focused view or the record tab', () => {
    const unscoped = pkg.contributes.keybindings.filter((k) => ![...VIEW_SCOPES, RECORD_TAB_SCOPE].some((scope) => requires(k.when, scope)));
    expect(unscoped.map((k) => `${k.key} → ${k.command}`)).toEqual([]);
  });

  it('binds every view key only while the tree itself has focus — never in a prompt, the tree\'s find box or the view\'s title bar', () => {
    const rowKeys = pkg.contributes.keybindings.filter((k) => VIEW_SCOPES.some((scope) => requires(k.when, scope)));
    expect(rowKeys.length).toBeGreaterThan(0);
    const firesOffTheTree = rowKeys.filter((k) => !ON_THE_TREE.every((term) => requires(k.when, term)));
    expect(firesOffTheTree.map((k) => `${k.key} → ${k.command} (when: ${k.when})`)).toEqual([]);
  });
});

describe('package.json Downloads keys', () => {
  it.each([
    ['modbench.copyValue', 'ctrl+c', 'cmd+c'],
    ['modbench.downloadedFile.delete', 'Delete', 'cmd+backspace'],
  ])('%s is bound to %s, scoped to the focused Downloads view in an instance', (command, key, mac) => {
    const binding = present(
      pkg.contributes.keybindings.find((k) => k.command === command && requires(k.when, 'focusedView == modbench.downloads')),
      `a key for ${command} on the Downloads view`,
    );
    expect(binding.key).toBe(key);
    expect(binding.mac).toBe(mac);
    expect(requires(binding.when, IN_AN_INSTANCE)).toBe(true);
  });
});

describe('package.json Ctrl+C keys', () => {
  const COPY_KEYS = [
    'modbench.modList', 'modbench.pluginListTree', 'modbench.downloads', 'modbench.referencedByTree',
  ] as const;
  const copyKeys: { command: string; key: string; mac?: string; when: string; args?: unknown }[] =
    pkg.contributes.keybindings.filter((k: { command: string }) => k.command === 'modbench.copyValue');

  it.each(COPY_KEYS)('%s binds Ctrl+C to copy value, handing it its own view', (view) => {
    const entry = present(copyKeys.find((k) => requires(k.when, `focusedView == ${view}`)), `a Ctrl+C key for ${view}`);
    expect(entry.key).toBe('ctrl+c');
    expect(entry.mac).toBe('cmd+c');
    expect(entry.args).toEqual({ view });
  });

  it('binds no other Ctrl+C but the record grid\'s', () => {
    expect(copyKeys).toHaveLength(COPY_KEYS.length + 1);
  });
});

describe('package.json field gestures\' palette entries', () => {
  const ON_A_RECORD_TAB = { activeCustomEditorId: 'modbench.record' };
  const SECTION = 'modbench.record.focusedCellSection';
  const FIELD_PALETTE = [
    ['modbench.record.addElement', { [SECTION]: 'arrayParent' }],
    ['modbench.record.removeElement', { [SECTION]: 'arrayElement' }],
    ['modbench.record.moveElementUp', { [SECTION]: 'arrayElement', 'modbench.record.focusedCellCanMoveUp': true }],
    ['modbench.record.moveElementDown', { [SECTION]: 'arrayElement', 'modbench.record.focusedCellCanMoveDown': true }],
    ['modbench.record.editField', { [SECTION]: 'stringValue' }],
    ['modbench.record.openFieldValue', { [SECTION]: 'stringValue' }],
  ] as const;

  it.each(FIELD_PALETTE)('%s is in the palette on a record tab, on a cell that holds what it acts on', (command, facts) => {
    expect(paletteOffers(command, { ...ON_A_RECORD_TAB, ...facts })).toBe(true);
    expect(paletteOffers(command, ON_A_RECORD_TAB)).toBe(false);
  });

  it.each(eachMissingFact(FIELD_PALETTE))('%s is not in the palette without %s', (command, fact, facts) => {
    expect(paletteOffers(command, { ...ON_A_RECORD_TAB, ...without(facts, fact) })).toBe(false);
  });

  it.each(['sideBarFocus', 'panelFocus', 'auxiliaryBarFocus'])('add element is not in the palette while %s', (focus) => {
    expect(paletteOffers('modbench.record.addElement', { ...ON_A_RECORD_TAB, [SECTION]: 'arrayParent', [focus]: true })).toBe(false);
  });
});

describe('package.json record grid keys, as editor.md\'s Menus and keys and its focused cell\'s story 7 place them', () => {
  const ON_A_RECORD_TAB = { activeCustomEditorId: 'modbench.record' };
  const SECTION = 'modbench.record.focusedCellSection';
  const EDIT = { key: 'f2', command: 'modbench.recordGrid.editHere' };
  const CUT = { key: 'ctrl+x', mac: 'cmd+x', command: 'modbench.recordGrid.cutHere' };
  const PASTE = { key: 'ctrl+v', mac: 'cmd+v', command: 'modbench.recordGrid.pasteHere' };
  const REMOVE = { key: 'Delete', mac: 'cmd+backspace', command: 'modbench.record.removeElement' };
  const CLEAR = { key: 'Delete', mac: 'cmd+backspace', command: 'modbench.recordGrid.clearHere' };

  it.each([
    [{}, []],
    [{ [SECTION]: 'cell' }, [EDIT]],
    [{ [SECTION]: 'cell editableCell' }, [EDIT, CUT, PASTE, CLEAR]],
    [{ [SECTION]: 'cell editableCell arrayElement' }, [EDIT, CUT, PASTE, REMOVE]],
    [{ 'modbench.record.focusedCellCopies': true }, [{ key: 'ctrl+c', mac: 'cmd+c', command: 'modbench.copyValue' }]],
    [{ [SECTION]: 'arrayElement', 'modbench.record.focusedCellCanMoveUp': true }, [REMOVE, { key: 'alt+up', command: 'modbench.record.moveElementUp' }]],
    [{ [SECTION]: 'arrayElement', 'modbench.record.focusedCellCanMoveDown': true }, [REMOVE, { key: 'alt+down', command: 'modbench.record.moveElementDown' }]],
  ])('on a record tab with %j the keys that fire are those of what the focused cell holds', (facts, keys) => {
    expectKeysFiring({ ...ON_A_RECORD_TAB, ...facts }, keys);
  });

  it.each(['modbench.record.focusedCellEditorOpen', 'inputFocus', 'sideBarFocus', 'panelFocus', 'auxiliaryBarFocus'])(
    'acts on no key while %s', (blocker) => {
      const cell = {
        ...ON_A_RECORD_TAB, [SECTION]: 'cell editableCell arrayElement', 'modbench.record.focusedCellCopies': true,
        'modbench.record.focusedCellCanMoveUp': true, 'modbench.record.focusedCellCanMoveDown': true,
      };
      expect(keysFiring(cell)).not.toEqual([]);
      expect(keysFiring({ ...cell, [blocker]: true })).toEqual([]);
    });
});

describe('package.json track\'s palette entry', () => {
  const MODS = { focusedView: 'modbench.modList', ...inInstance, 'modbench.mod.holdsUntrackedModWithPlugin': true, 'modbench.mod.trackRowsIn': 'modbench.modList' };
  const PLUGINS = { focusedView: 'modbench.pluginListTree', ...inInstance, 'modbench.plugin.allInUntrackedMod': true, 'modbench.mod.trackRowsIn': 'modbench.pluginListTree' };

  it('is in the palette while Mods or Plugins has focus, was last selected in, and holds what track acts on', () => {
    expect(paletteOffers('modbench.mod.track', MODS)).toBe(true);
    expect(paletteOffers('modbench.mod.track', PLUGINS)).toBe(true);
  });

  it('is not in the palette when the last selection was made in the other view', () => {
    expect(paletteOffers('modbench.mod.track', { ...MODS, 'modbench.mod.trackRowsIn': 'modbench.pluginListTree' })).toBe(false);
    expect(paletteOffers('modbench.mod.track', { ...PLUGINS, 'modbench.mod.trackRowsIn': 'modbench.modList' })).toBe(false);
  });

  it('is not in the palette when the focused view holds nothing to track', () => {
    expect(paletteOffers('modbench.mod.track', without(MODS, 'modbench.mod.holdsUntrackedModWithPlugin'))).toBe(false);
    expect(paletteOffers('modbench.mod.track', without(PLUGINS, 'modbench.plugin.allInUntrackedMod'))).toBe(false);
  });
});

describe('package.json conflict table menus follow mods-conflicts.md', () => {
  const inTable = (section: string): MenuEntry[] => present(pkg.contributes.menus['webview/context'], "contributes.menus['webview/context']")
    .filter((e) => holds(e.when, { webviewId: 'modbench.conflicts', webviewSection: section }));

  it('column header: open conflicts, and nothing else', () => {
    expect(placed(inTable('conflictColumn'))).toEqual([['modbench.mod.openConflicts', '1_open']]);
  });

  it('cell: compare file, and nothing else', () => {
    expect(placed(inTable('conflictCell'))).toEqual([['modbench.mod.compareFile', '1_open']]);
  });
});

describe('package.json menus and keys on an editor tab', () => {
  it('name each editor the extension contributes, and no other, so each is offered on that editor\'s tabs', () => {
    const whens = [...Object.values(pkg.contributes.menus).flat(), ...pkg.contributes.keybindings].map((entry) => entry.when);
    const named = new Set(whens.flatMap((when) => [...when.matchAll(/(?:activeCustomEditorId|webviewId) == '([^']+)'/g)].map(([, viewType]) => viewType)));

    expect([...named].sort()).toEqual(pkg.contributes.customEditors.map((editor) => editor.viewType).sort());
  });
});

describe('package.json record tab menus', () => {
  const menu = (): MenuEntry[] => present(pkg.contributes.menus['webview/context'], "contributes.menus['webview/context']")
    .filter((e) => requires(e.when, "webviewId == 'modbench.record'"));
  const tab = { webviewId: 'modbench.record' };
  const offered = (facts: Record<string, unknown>): string[] =>
    placed(menu().filter((e) => holds(e.when, { ...tab, ...facts }))).map(([command]) => command);

  it('places each item in its group', () => {
    expect(placed(menu())).toEqual([
      ['modbench.record.openReference', '1_open'],
      ['modbench.record.openFieldValue', '1_open'],
      ['modbench.record.addElement', '2_change'],
      ['modbench.record.removeElement', '2_change'],
      ['modbench.record.moveElementUp', '2_change'],
      ['modbench.record.moveElementDown', '2_change'],
      ['modbench.mod.track', '4_sourceControl'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.plugin.compile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
      ['modbench.record.copy', '5_copy'],
      ['modbench.record.delete', '6_destroy'],
    ]);
  });

  it('offers on a cell go to record, open field value, add, remove, move and copy value, in that order', () => {
    expect(offered({
      webviewSection: 'cell reference stringValue arrayParent arrayElement', copyText: 'x', canMoveUp: true, canMoveDown: true,
    })).toEqual([
      'modbench.record.openReference', 'modbench.record.openFieldValue', 'modbench.record.addElement',
      'modbench.record.removeElement', 'modbench.record.moveElementUp', 'modbench.record.moveElementDown', 'modbench.copyValue',
    ]);
  });

  it('offers copy value on a cell with something to copy and none on a cell with nothing', () => {
    expect(offered({ webviewSection: 'cell', copyText: 'x' })).toEqual(['modbench.copyValue']);
    expect(offered({ webviewSection: 'cell' })).toEqual([]);
  });

  it.each([
    ['an untracked mod', 'untracked', false, false, ['modbench.mod.track', 'modbench.record.copy']],
    ['a tracked mod', 'tracked', false, false, ['modbench.plugin.decompile', 'modbench.record.copy']],
    ['a tracked mod, compilable but not editable', 'tracked', true, false, [
      'modbench.plugin.decompile', 'modbench.plugin.compile', 'modbench.record.copy',
    ]],
    ['a tracked mod, editable', 'tracked', true, true, [
      'modbench.plugin.decompile', 'modbench.plugin.compile', 'modbench.record.copy', 'modbench.record.delete',
    ]],
    ['the game or Overwrite, in no mod', 'none', false, false, ['modbench.record.copy']],
  ])('offers on the column of a plugin in %s only what applies', (_what, inMod, compilable, editable, commands) => {
    expect(offered({ webviewSection: 'recordHeader', inMod, compilable, editable })).toEqual(commands);
  });

  it('hides the internal command that follows a reference from the palette', () => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === 'modbench.record.openReference');
    expect(entries.map((e) => e.when)).toEqual(['false']);
  });
});

describe('package.json compile\'s palette entry', () => {
  it('is in the palette in an instance while any plugin compiles', () => {
    expect(paletteOffers('modbench.plugin.compile', { ...inInstance, 'modbench.plugin.anyCompilable': true })).toBe(true);
    expect(paletteOffers('modbench.plugin.compile', inInstance)).toBe(false);
    expect(paletteOffers('modbench.plugin.compile', { 'modbench.plugin.anyCompilable': true })).toBe(false);
  });
});

function describePaletteGate(view: string, rows: readonly (readonly [string, Context])[]): void {
  const focused = { focusedView: view, ...inInstance };

  it.each(rows)('%s is in the palette while the view has focus and its selection holds what it acts on', (command, facts) => {
    expect(paletteOffers(command, { ...focused, ...facts })).toBe(true);
  });

  it.each(eachMissingFact(rows))('%s is not in the palette without %s', (command, fact, facts) => {
    expect(paletteOffers(command, { ...focused, ...without(facts, fact) })).toBe(false);
  });

  it.each(rows)('%s is not in the palette while another view has focus', (command, facts) => {
    expect(paletteOffers(command, { ...focused, focusedView: 'modbench.other', ...facts })).toBe(false);
  });

  it.each(rows)('%s is not in the palette outside an instance', (command, facts) => {
    expect(paletteOffers(command, { focusedView: view, ...facts })).toBe(false);
  });
}

describe('package.json Plugins palette entries', () => {
  const IN_PLUGINS = { 'modbench.record.selectionIn': 'modbench.pluginListTree' };
  describePaletteGate('modbench.pluginListTree', [
    ['modbench.plugin.reveal', { 'modbench.plugin.singlePlugin': true }],
    ['modbench.plugin.rename', { 'modbench.plugin.singleTracked': true }],
    ['modbench.plugin.move', { 'modbench.plugin.holdsPluginLine': true }],
    ['modbench.plugin.decompile', { 'modbench.plugin.allInTrackedMod': true }],
    ['modbench.record.create', { 'modbench.plugin.singleCreatable': true }],
    ['modbench.record.delete', { 'modbench.plugin.allDeletableRecords': true, ...IN_PLUGINS }],
    ['modbench.record.copy', { 'modbench.plugin.allRecords': true, ...IN_PLUGINS }],
  ]);

  it.each(['modbench.record.delete', 'modbench.record.copy'])('%s is not in the palette on a record selection made in another view', (command) => {
    const facts = { 'modbench.plugin.allDeletableRecords': true, 'modbench.plugin.allRecords': true, 'modbench.record.selectionIn': 'modbench.referencedByTree' };
    expect(paletteOffers(command, { focusedView: 'modbench.pluginListTree', ...inInstance, ...facts })).toBe(false);
  });
});

describe('package.json Downloads palette entries', () => {
  const DOWNLOADS_PALETTE = [
    ['modbench.downloadedFile.open', 'modbench.downloadedFile.singleFile'],
    ['modbench.downloadedFile.openMeta', 'modbench.downloadedFile.singleFileWithMeta'],
    ['modbench.downloadedFile.delete', 'modbench.downloadedFile.holdsFile'],
    ['modbench.downloadedFile.exclude', 'modbench.downloadedFile.holdsIncluded'],
    ['modbench.downloadedFile.include', 'modbench.downloadedFile.holdsExcluded'],
  ] as const;

  it.each(DOWNLOADS_PALETTE)('%s is in the palette only while the Downloads view has focus in an instance and its selection holds: %s', (command, term) => {
    const when = present(
      present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']").find((e) => e.command === command),
      `a commandPalette entry for ${command}`,
    ).when;
    expect(requires(when, 'focusedView == modbench.downloads')).toBe(true);
    expect(requires(when, IN_AN_INSTANCE)).toBe(true);
    expect(requires(when, term)).toBe(true);
  });
});

describe('package.json Mods row menu', () => {
  const MOD = { kind: 'mod', name: 'X' } as const;
  const commandsOn = (contextValue: string | undefined): string[] => offeredIn(
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']"),
    { view: 'modbench.modList', viewItem: present(contextValue, "the row's own contextValue") });
  const disabledRow = (): string[] => commandsOn(new ModNode({ ...MOD, enabled: false, nexusId: '1' }).contextValue);
  const enabledRow = (): string[] => commandsOn(new ModNode({ ...MOD, enabled: true }).contextValue);
  const toggles = (commands: string[]): string[] => commands.filter((c) => c === 'modbench.mod.enable' || c === 'modbench.mod.disable');

  it('offers enable only on a disabled row, and disable only on an enabled one, whether or not it has a Nexus id', () => {
    expect(toggles(disabledRow())).toEqual(['modbench.mod.enable']);
    expect(toggles(enabledRow())).toEqual(['modbench.mod.disable']);
  });

  it.each(['modbench.mod.move', 'modbench.copyValue'])('offers %s on every mod row, enabled or not, and on every separator row, but not Overwrite', (command) => {
    expect(enabledRow()).toContain(command);
    expect(disabledRow()).toContain(command);
    expect(commandsOn(new SeparatorNode({ kind: 'separator', name: 'S', enabled: true }, []).contextValue)).toContain(command);
    expect(commandsOn(new OverwriteNode([], 'MO2').contextValue)).not.toContain(command);
  });
});

describe('package.json Mods title bar, menus, keys and palette follow mods.md', () => {
  const MODS_VIEW = 'view == modbench.modList';
  const inModsView = (menu: string): MenuEntry[] =>
    present(pkg.contributes.menus[menu], `contributes.menus['${menu}']`).filter((e) => requires(e.when, MODS_VIEW));
  const rowMenu = (row: string): MenuEntry[] => inModsView('view/item/context').filter((e) => requires(e.when, row));
  const MOD_ROW = String.raw`viewItem =~ /\bmod\b/`;

  it('title bar: filter or clear, then sort direction, as icons, with Collapse All left to VS Code; install then create empty mod in the overflow', () => {
    expect(placed(inModsView('view/title'))).toEqual([
      ['modbench.modList.filterHere', 'navigation'],
      ['modbench.modList.clearFilterHere', 'navigation'],
      ['modbench.mod.sortWinningAtTop', 'navigation'],
      ['modbench.mod.sortLosingAtTop', 'navigation'],
      ['modbench.mod.install', '3_create'],
      ['modbench.mod.createEmpty', '3_create'],
    ]);
  });

  it('mod menu: open, change, create, source control, copy, then destroy', () => {
    expect(placed(rowMenu(MOD_ROW))).toEqual([
      ['modbench.mod.openFolder', '1_open'],
      ['modbench.mod.openConflicts', '1_open'],
      ['modbench.mod.viewOnNexus', '1_open'],
      ['modbench.mod.enable', '2_change'],
      ['modbench.mod.disable', '2_change'],
      ['modbench.mod.move', '2_change'],
      ['modbench.mod.rename', '2_change'],
      ['modbench.separator.add', '3_create'],
      ['modbench.mod.createEmpty', '3_create'],
      ['modbench.mod.install', '3_create'],
      ['modbench.mod.track', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
      ['modbench.mod.uninstall', '6_destroy'],
    ]);
  });

  it('mod menu: track only on a mod that has no repository and holds a plugin', () => {
    const track = present(rowMenu(MOD_ROW).find((e) => e.command === 'modbench.mod.track'), 'the mod menu\'s track');
    expect(holds(track.when, { view: 'modbench.modList', viewItem: 'mod enabled holdsPlugin untracked' })).toBe(true);
    expect(holds(track.when, { view: 'modbench.modList', viewItem: 'mod enabled holdsPlugin' })).toBe(false);
    expect(holds(track.when, { view: 'modbench.modList', viewItem: 'mod enabled untracked' })).toBe(false);
  });

  it('mod menu: open conflicts only on a mod that has a file order conflict', () => {
    const entry = present(rowMenu(MOD_ROW).find((e) => e.command === 'modbench.mod.openConflicts'), 'the mod menu\'s open conflicts');
    expect(holds(entry.when, { view: 'modbench.modList', viewItem: 'mod enabled untracked fileOrderConflict' })).toBe(true);
    expect(holds(entry.when, { view: 'modbench.modList', viewItem: 'mod enabled untracked' })).toBe(false);
  });

  it('mod menu: enable and disable share one slot', () => {
    const slot = (command: string) => present(rowMenu(MOD_ROW).find((e) => e.command === command), command).group;
    expect(slot('modbench.mod.enable')).toBe(slot('modbench.mod.disable'));
  });

  it('separator menu: move, add separator, rename, copy value, delete', () => {
    expect(placed(rowMenu('viewItem == separator'))).toEqual([
      ['modbench.mod.move', '2_change'],
      ['modbench.separator.add', '3_create'],
      ['modbench.separator.rename', '3_create'],
      ['modbench.copyValue', '5_copy'],
      ['modbench.separator.delete', '6_destroy'],
    ]);
  });

  it('Overwrite menu: open folder', () => {
    expect(placed(rowMenu('viewItem == runtimeOutput'))).toEqual([['modbench.mod.openFolder', '1_open']]);
  });

  const menuOn = (viewItem: string): [string, string][] =>
    placed(inModsView('view/item/context').filter((e) => holds(e.when, { view: 'modbench.modList', viewItem })));

  it('File menu: open folder, then copy value, and no item of a mod\'s, a separator\'s or Overwrite\'s', () => {
    expect(menuOn('file')).toEqual([['modbench.mod.openFolder', '1_open'], ['modbench.copyValue', '5_copy']]);
  });

  it('File menu: go to mod only on a file in a file order conflict, between open folder and copy value', () => {
    expect(menuOn('file conflict')).toEqual([
      ['modbench.mod.openFolder', '1_open'], ['modbench.mod.goToMod', '1_open'], ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('File menu: compare file only on a file that loses its file order conflict, after open folder and before go to mod', () => {
    expect(menuOn('file conflict losing')).toEqual([
      ['modbench.mod.openFolder', '1_open'], ['modbench.mod.compareFile', '1_open'], ['modbench.mod.goToMod', '1_open'], ['modbench.copyValue', '5_copy'],
    ]);
    expect(menuOn('file conflict').map(([command]) => command)).not.toContain('modbench.mod.compareFile');
    expect(menuOn('file').map(([command]) => command)).not.toContain('modbench.mod.compareFile');
  });

  it.each([
    ['file included', 'modbench.mod.excludeFile'],
    ['file excluded', 'modbench.mod.includeFile'],
  ])('File menu on a %s row: %s, after open folder and any go to mod, before copy value', (viewItem, command) => {
    expect(menuOn(viewItem)).toEqual([['modbench.mod.openFolder', '1_open'], [command, '2_change'], ['modbench.copyValue', '5_copy']]);
    expect(menuOn(`file conflict ${viewItem.split(' ')[1]}`)).toEqual([
      ['modbench.mod.openFolder', '1_open'], ['modbench.mod.goToMod', '1_open'], [command, '2_change'], ['modbench.copyValue', '5_copy'],
    ]);
  });

  it('Folder menu: open folder, then copy value, and no item of a mod\'s, a separator\'s or Overwrite\'s', () => {
    expect(menuOn('folder')).toEqual([['modbench.mod.openFolder', '1_open'], ['modbench.copyValue', '5_copy']]);
  });

  const ON_THE_TREE = { focusedView: 'modbench.modList', listFocus: true, ...inInstance };
  const COPY = { key: 'ctrl+c', mac: 'cmd+c', command: 'modbench.copyValue' };
  const UNINSTALL = { key: 'Delete', mac: 'cmd+backspace', command: 'modbench.mod.uninstall' };
  const DELETE_SEPARATOR = { key: 'Delete', mac: 'cmd+backspace', command: 'modbench.separator.delete' };

  it.each([
    [{}, []],
    [{ 'modbench.mod.selectionToggle': 'enable' }, [{ key: 'space', command: 'modbench.mod.enable' }]],
    [{ 'modbench.mod.selectionToggle': 'disable' }, [{ key: 'space', command: 'modbench.mod.disable' }]],
    [{ 'modbench.mod.selectionKind': 'mod' }, [UNINSTALL]],
    [{ 'modbench.mod.selectionKind': 'separator' }, [DELETE_SEPARATOR]],
    [{ 'modbench.mod.selectionKind': 'mod', 'modbench.mod.singleRow': true }, [UNINSTALL, { key: 'f2', mac: 'enter', command: 'modbench.mod.rename' }]],
    [{ 'modbench.mod.selectionKind': 'separator', 'modbench.mod.singleRow': true }, [DELETE_SEPARATOR, { key: 'f2', mac: 'enter', command: 'modbench.separator.rename' }]],
  ])('on the focused Mods tree with %j, the keys that fire are those of the commands the selection allows, and copy value', (facts, keys) => {
    expectKeysFiring({ ...ON_THE_TREE, ...facts }, [...keys, COPY]);
  });

  const ONE_MOD = { 'modbench.mod.selectionKind': 'mod', 'modbench.mod.singleRow': true };
  const ONE_SEPARATOR = { 'modbench.mod.selectionKind': 'separator', 'modbench.mod.singleRow': true };
  describePaletteGate('modbench.modList', [
    ['modbench.mod.enable', { 'modbench.mod.holdsDisabledMod': true }],
    ['modbench.mod.disable', { 'modbench.mod.holdsEnabledMod': true }],
    ['modbench.mod.move', { 'modbench.mod.selectionKind': 'mod' }],
    ['modbench.separator.add', ONE_MOD],
    ['modbench.mod.rename', ONE_MOD],
    ['modbench.separator.rename', ONE_SEPARATOR],
    ['modbench.separator.delete', { 'modbench.mod.selectionKind': 'separator' }],
    ['modbench.mod.uninstall', { 'modbench.mod.selectionKind': 'mod' }],
    ['modbench.mod.createEmpty', {}],
    ['modbench.mod.install', {}],
    ['modbench.mod.openFolder', { 'modbench.mod.singleOpenFolderRow': true }],
    ['modbench.mod.goToMod', { 'modbench.mod.singleGoToModRow': true }],
    ['modbench.mod.openConflicts', { 'modbench.mod.singleOpenConflictsRow': true }],
    ['modbench.mod.compareFile', { 'modbench.mod.singleCompareFileRow': true }],
    ['modbench.mod.excludeFile', { 'modbench.mod.holdsIncludedFile': true }],
    ['modbench.mod.includeFile', { 'modbench.mod.holdsExcludedFile': true }],
  ]);

  it.each([
    ['modbench.separator.delete', 'mod'],
    ['modbench.mod.uninstall', 'separator'],
    ['modbench.mod.rename', 'separator'],
    ['modbench.separator.rename', 'mod'],
  ])('%s is not in the palette on a %s selection', (command, kind) => {
    const selection = { focusedView: 'modbench.modList', ...inInstance, 'modbench.mod.selectionKind': kind, 'modbench.mod.singleRow': true };
    expect(paletteOffers(command, selection)).toBe(false);
  });

  it('offers view on Nexus in the palette on the focused Mods view only while its row is the one the command opens', () => {
    const mods = { focusedView: 'modbench.modList', ...inInstance };
    expect(paletteOffers('modbench.mod.viewOnNexus', { ...mods, 'modbench.mod.nexusRowIn': 'modbench.modList' })).toBe(true);
    expect(paletteOffers('modbench.mod.viewOnNexus', { ...mods, 'modbench.mod.nexusRowIn': 'modbench.downloads' })).toBe(false);
  });

  it('the empty list\'s message names the overflow\'s own titles', () => {
    const overflowTitles = inModsView('view/title').filter((e) => groupOf(e) !== 'navigation')
      .map((e) => present(pkg.contributes.commands.find((c) => c.command === e.command), e.command).title);
    expect(overflowTitles.length).toBeGreaterThan(0);
    for (const title of overflowTitles) expect(NO_MODS_MESSAGE).toContain(title);
    expect(NO_MODS_MESSAGE).toContain('overflow');
  });
});

describe('package.json open to the side', () => {
  it('reads Open to the Side', () => {
    expect(pkg.contributes.commands.find((c) => c.command === OPEN_TO_THE_SIDE)?.title).toBe('Open to the Side');
  });
});

function catalogCommandIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  let idColumn: number | undefined;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      idColumn = undefined;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (idColumn === undefined) {
      idColumn = cells.indexOf('Command ID');
      continue;
    }
    if (idColumn === -1) continue;
    for (const match of (cells[idColumn] ?? '').matchAll(/`(modbench\.[\w.]+)`/g)) {
      ids.add(present(match[1], 'the backticked Command ID'));
    }
  }
  return ids;
}

const commandsMarkdown = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'docs', 'architecture', 'commands.md'), 'utf8',
);

const catalog = catalogCommandIds(commandsMarkdown);

const OPEN_TO_THE_SIDE = 'modbench.record.openToSide';
const OPEN_REFERENCE = 'modbench.record.openReference';
const FILTER_ENTRY_POINTS = ['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads', 'modbench.referencedByTree']
  .flatMap((view) => [`${view}.filterHere`, `${view}.clearFilterHere`]);
const GRID_KEY_ENTRY_POINTS = ['editHere', 'cutHere', 'pasteHere', 'clearHere'].map((verb) => `modbench.recordGrid.${verb}`);
const ENTRY_POINTS = [...FILTER_ENTRY_POINTS, ...GRID_KEY_ENTRY_POINTS, OPEN_TO_THE_SIDE, OPEN_REFERENCE];

describe('package.json registers every command under its catalog Command ID', () => {
  const registered = pkg.contributes.commands.map((c) => c.command);

  it('reads the Command ID column of every catalog table', () => {
    expect(catalog).toContain('modbench.mod.enable');
    expect(catalog).toContain('modbench.downloadedFile.hideExcluded');
    expect(catalog).toContain('modbench.plugin.sync');
  });

  it('registers no ID that is not in the catalog', () => {
    const offenders = registered.filter((id) => !catalog.has(id) && !ENTRY_POINTS.includes(id));
    expect(
      offenders,
      offenders.map((id) => `${id} is not a Command ID in docs/architecture/commands.md. The catalog is the `
        + 'source: register the gesture under the ID its row gives it.').join('\n'),
    ).toEqual([]);
  });
});

const wordsOf = (camel: string): string[] => camel.split(/(?=[A-Z])/).map((w) => w.toLowerCase());

function expectTitleNamesVerbAndObject(id: string, title: string): void {
  const everyView = /^modbench\.(\w+)$/.exec(id)?.[1];
  if (everyView !== undefined) {
    expect(title.replace('…', '').toLowerCase().split(/\s+/), `the title of ${id} is its verb alone`).toEqual(wordsOf(everyView));
    return;
  }
  const [, object = '', verb = ''] = present(
    /^modbench\.(\w+)\.(\w+)$/.exec(id) ?? undefined, `${id} as modbench.<object>.<verb>`);
  const titleWords = title.replace('…', '').toLowerCase().split(/\s+/);
  const objectWords = wordsOf(object);
  const noun = present(objectWords.pop(), `the noun of ${object}`);
  expect(titleWords, `the title of ${id} names the verb`).toEqual(expect.arrayContaining(wordsOf(verb)));
  expect(titleWords, `the title of ${id} names the object`).toEqual(expect.arrayContaining(objectWords));
  expect(titleWords.some((w) => w === noun || w === `${noun}s`), `the title of ${id} names the ${noun}`).toBe(true);
}

describe('package.json palette titles are the verb and the object', () => {
  const titled = pkg.contributes.commands.filter((c) => catalog.has(c.command));

  it.each(titled.map((c) => [c.command, c.title]))('%s is titled "%s"', (id, title) => {
    expectTitleNamesVerbAndObject(id, title);
  });
});

describe('package.json Delete keys', () => {
  it('each passes its own view as args, since a key cannot name the rows it deletes', () => {
    const deleteKeys = pkg.contributes.keybindings.filter((k) => k.command === 'modbench.record.delete');
    expect(deleteKeys.map((k) => [k.key, k.args])).toEqual([
      ['Delete', { view: 'modbench.referencedByTree' }],
      ['Delete', { view: 'modbench.pluginListTree' }],
    ]);
  });
});

describe('package.json Referenced By menus and keys', () => {
  const menuOf = (viewItem: string) =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => holds(e.when, { view: 'modbench.referencedByTree', viewItem }))
      .map((e) => [e.command, e.group]);

  it('offers a referrer open to the side then copy value, and a plugin copy copy… then delete', () => {
    expect([menuOf('referencedByReferrer'), menuOf('referencedByHolder')]).toEqual([
      [[OPEN_TO_THE_SIDE, '1_open@1'], ['modbench.copyValue', '5_copy@1']],
      [['modbench.record.copy', '5_copy@1'], ['modbench.record.delete', '6_destroy@1']],
    ]);
  });

  it('binds Delete in the view only while every selected row is a plugin copy', () => {
    const onTheTree = { focusedView: 'modbench.referencedByTree', listFocus: true, ...inInstance };
    const copy = { key: 'ctrl+c', mac: 'cmd+c', command: 'modbench.copyValue' };
    expectKeysFiring({ ...onTheTree, 'modbench.referencedBy.allHolders': true }, [
      copy, { key: 'Delete', mac: 'cmd+backspace', command: 'modbench.record.delete' },
    ]);
    expectKeysFiring(onTheTree, [copy]);
  });
});
