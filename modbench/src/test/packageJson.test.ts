import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { present } from '../ports/present';
import { FOLDER_KEY, INSTANCE_READ_KEY } from '../folderContext';
import { IN_AN_INSTANCE, holds, isRecord, requires } from './manifest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString, uriFile,
} from './vscodeMock';

const groupOf = (entry: MenuEntry): string => (entry.group ?? '').split('@')[0] ?? '';
const orderOf = (entry: MenuEntry): number => Number((entry.group ?? '').split('@')[1] ?? Number.NaN);
// VS Code draws the navigation group first, then the other groups by name, each by its order.
const rank = (group: string): string => (group === 'navigation' ? '' : group);
const placed = (entries: readonly MenuEntry[]): [string, string][] =>
  [...entries]
    .sort((a, b) => rank(groupOf(a)).localeCompare(rank(groupOf(b))) || orderOf(a) - orderOf(b))
    .map((e) => [e.command, groupOf(e)]);

// Only the Mods and Downloads row menus' own contextValue-vs-when tests below need a live
// ModNode, SeparatorNode, OverwriteNode or DownloadNode.
vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile },
}));

import { ModNode, NO_MODS_MESSAGE, OverwriteNode, SeparatorNode } from '../mods/ModListProvider';
import { MODS_KEY_ARGS } from '../mods/gestureEntry';
import { PLUGINS_KEY_ARGS } from '../plugins/gestureEntry';
import { NO_PLUGINS_MESSAGE } from '../plugins/PluginsTreeProvider';
import { DECOMPILE_PLUGIN_TITLE } from '../plugins/externalChangeNotice';
import { DownloadNode } from '../downloads/DownloadsProvider';
import { downloadRowFixture } from './mo2/downloadRowFixture';

// This file's one parse point for package.json: checks the fields every read below assumes and
// throws rather than handing back an unproven shape.
interface ViewsWelcomeEntry { view: string; contents: string; when?: string; }
interface ViewEntry { id: string; name: string; when?: string; }
interface MenuEntry { command: string; when: string; group?: string; icon?: string; }
interface CommandEntry { command: string; title: string; category: string; icon?: string; }
interface KeybindingEntry { command: string; key: string; when: string; mac?: string; args?: unknown; }
interface ViewsContainerEntry { id: string; }
interface SettingEntry { description?: string; }

interface PackageManifest {
  contributes: {
    viewsWelcome: ViewsWelcomeEntry[];
    views: Record<string, ViewEntry[]>;
    viewsContainers: { panel: ViewsContainerEntry[] };
    menus: Record<string, MenuEntry[]>;
    commands: CommandEntry[];
    keybindings: KeybindingEntry[];
    configuration: { properties: Record<string, SettingEntry> };
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

function parsePackageManifest(raw: unknown): PackageManifest {
  if (!isRecord(raw)) throw new Error('Expected package.json to be an object.');
  const { contributes } = raw;
  if (!isRecord(contributes)) throw new Error('Expected package.json to have a contributes object.');
  const { viewsWelcome, views, viewsContainers, menus, commands, keybindings, configuration } = contributes;
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
  const { properties } = configuration;
  return {
    contributes: {
      viewsWelcome, views, viewsContainers: { panel: viewsContainers.panel }, menus, commands, keybindings,
      configuration: { properties },
    },
  };
}

const pkg = parsePackageManifest(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')),
);

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

  // downloads.md, States, story 2: distinct from "no downloads yet", never both at once.
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

  // Which commands exist only inside an instance is the running extension's answer, checked by
  // the not-an-instance integration suite; this holds the keys to the palette's word.
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

  // `&&` binds tighter than `||` in a when clause, so a term in every alternative gates them all.
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

  it('evaluates a clause against the context it is given', () => {
    const on = { view: 'modbench.pluginListTree', viewItem: 'plugin compilable' };
    expect(holds(String.raw`view == modbench.pluginListTree && viewItem =~ /\bcompilable\b/`, on)).toBe(true);
    expect(holds(String.raw`view == modbench.pluginListTree && viewItem =~ /\buntrackedInMod\b/`, on)).toBe(false);
    expect(holds(String.raw`view == modbench.pluginListTree && !(viewItem =~ /\bcompilable\b/)`, on)).toBe(false);
    expect(holds('view == modbench.pluginListTree && (viewItem == plugin || viewItem == other)', { ...on, viewItem: 'plugin' })).toBe(true);
    expect(holds("webviewId == 'modbench' && compilable", { webviewId: 'modbench', compilable: true })).toBe(true);
    expect(holds("webviewId == 'modbench' && compilable", { webviewId: 'modbench' })).toBe(false);
    expect(holds('origin in modbench.mod.tracked', { origin: 'A', 'modbench.mod.tracked': ['A'] })).toBe(true);
    expect(holds('origin in modbench.mod.tracked', { origin: 'B', 'modbench.mod.tracked': ['A'] })).toBe(false);
    expect(holds('origin in modbench.mod.tracked', { origin: 'A' })).toBe(false);
  });

  it('refuses a clause it cannot read, rather than reading it as ungated', () => {
    expect(() => requires(`${IN_AN_INSTANCE} && (view == a`, IN_AN_INSTANCE)).toThrow(/cannot read/);
    expect(() => requires(`${IN_AN_INSTANCE} && view == a)`, IN_AN_INSTANCE)).toThrow(/cannot read/);
  });
});

describe('package.json Referenced By panel migration', () => {
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

  // toolbox.md, Menus and keys: "Title bar | 1: refresh. Overflow: open settings."
  it('has refresh as its one title icon and open settings in its title bar\'s overflow', () => {
    const toolboxTitle = present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']")
      .filter((e) => requires(e.when, 'view == modbench.toolbox'));

    expect(toolboxTitle.map((e) => ({ command: e.command, icon: (e.group ?? '').startsWith('navigation') })))
      .toEqual([
        { command: 'modbench.instance.refresh', icon: true },
        { command: 'modbench.settings.open', icon: false },
      ]);
  });

  // toolbox.md, Menus and keys: "Profile menu | switch".
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
    present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']").filter((e) => e.when.includes(REFERENCED_BY_VIEW));

  it('offers filter or clear, then sort direction, as icons', () => {
    expect(placed(titleBar())).toEqual([
      ['modbench.referencedByTree.filterHere', 'navigation'],
      ['modbench.referencedByTree.clearFilterHere', 'navigation'],
      ['modbench.referrer.sortDescending', 'navigation'],
      ['modbench.referrer.sortAscending', 'navigation'],
    ]);
    expect(titleBar().map((e) => e.group)).toEqual(['navigation@1', 'navigation@1', 'navigation@2', 'navigation@2']);
  });

  it('slot 2 shows the one direction the list is not in', () => {
    const when = (command: string) => present(titleBar().find((e) => e.command === command), command).when;
    expect(when('modbench.referrer.sortDescending')).toBe(`${REFERENCED_BY_VIEW} && !modbench.referrer.descending && ${IN_AN_INSTANCE}`);
    expect(when('modbench.referrer.sortAscending')).toBe(`${REFERENCED_BY_VIEW} && modbench.referrer.descending && ${IN_AN_INSTANCE}`);
  });
});

describe('package.json New Plugin / record filter reachable from the merged tree', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const entryFor = (command: string) =>
    present(
      titleMenus().find((e) => e.command === command && e.when.includes('modbench.pluginListTree')),
      `a view/title entry for ${command} on modbench.pluginListTree`,
    );

  // commands.md, Chrome: the order.
  it('keeps modbench.plugin.filter at slot 1 (unchanged by this slice)', () => {
    expect(entryFor('modbench.pluginListTree.filterHere').group).toBe('navigation@1');
  });

  // plugins.md, Menus and keys: "3: filter records, or clear the record filter while active".
  it('shows filter records at slot 3, and the clear in its place while the record filter is active', () => {
    const filter = entryFor('modbench.record.filter');
    const clear = entryFor('modbench.record.clearFilter');
    expect(filter.group).toBe('navigation@3');
    expect(clear.group).toBe('navigation@3');
    expect(filter.when).toBe(`view == modbench.pluginListTree && !modbench.record.filterActive && ${IN_AN_INSTANCE}`);
    expect(clear.when).toBe(`view == modbench.pluginListTree && modbench.record.filterActive && ${IN_AN_INSTANCE}`);
  });

  it('places create plugin at slot 4', () => {
    expect(entryFor('modbench.plugin.create').group).toBe('navigation@4');
  });

  // commands.md, the catalog's `filter` under Record: a Plugins title icon and a code lens, the
  // palette aside.
  it('offers the record filter pair in no other menu', () => {
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

  // No dead entries (commands.md): outside an instance the title-bar icon is already absent
  // (gated by IN_AN_INSTANCE above), so the palette entry names the same gate.
  it('gates the palette entry the same way as the title-bar icon', () => {
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

  // commands.md, Chrome: the icons.
  const FILTERED_VIEWS = [
    ['modbench.modList', 'modbench.modList.filterHere'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filterHere'],
    ['modbench.downloads', 'modbench.downloads.filterHere'],
    ['modbench.referencedByTree', 'modbench.referencedByTree.filterHere'],
  ] as const;

  it.each(FILTERED_VIEWS)('%s narrows by name from slot 1', (view, command) => {
    const entry = present(
      titleMenus().find((e) => e.command === command && e.when.includes(view)),
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

  // The filter is durable, so it needs a way out: the two-command + context-key toggle template,
  // so slot 1 shows exactly one of the pair at a time. The key is per view.
  const DURABLE_FILTERS = [
    ['modbench.modList', 'modbench.modList.filterHere', 'modbench.modList.clearFilterHere', 'modbench.mod.filterActive'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filterHere', 'modbench.pluginListTree.clearFilterHere', 'modbench.plugin.filterActive'],
    ['modbench.downloads', 'modbench.downloads.filterHere', 'modbench.downloads.clearFilterHere', 'modbench.downloadedFile.filterActive'],
    ['modbench.referencedByTree', 'modbench.referencedByTree.filterHere', 'modbench.referencedByTree.clearFilterHere', 'modbench.referrer.filterActive'],
  ] as const;

  it.each(DURABLE_FILTERS)('%s swaps slot 1 to its clear variant while a filter is active', (view, open, clearCommand, key) => {
    const openEntry = present(
      titleMenus().find((e) => e.command === open && e.when.includes(`view == ${view}`)),
      `${open} on ${view}`,
    );
    const clearEntry = present(
      titleMenus().find((e) => e.command === clearCommand && e.when.includes(`view == ${view}`)),
      `${clearCommand} on ${view}`,
    );
    expect(openEntry.when).toBe(`view == ${view} && !${key} && ${IN_AN_INSTANCE}`);
    expect(clearEntry.when).toBe(`view == ${view} && ${key} && ${IN_AN_INSTANCE}`);
    expect(clearEntry.group).toBe('navigation@1');
  });

  it.each(DURABLE_FILTERS)('%s clears with $(clear-all)', (_view, _open, clearCommand) => {
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
    expect(entry.when).toBe(`view == modbench.toolbox && ${IN_AN_INSTANCE}`);
    expect(entry.group).toBe('navigation@1');
  });

});

describe('package.json title-bar rubric', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const viewsOf = (entries: MenuEntry[]) =>
    new Set(entries.map((e) => /view == ([\w.]+)/.exec(e.when)?.[1]).filter((v): v is string => v !== undefined));

  // commands.md, Chrome: an action that is not about a tree's own object.
  const WORKSPACE_ACTIONS = ['modbench.profile.switch'];

  it.each(WORKSPACE_ACTIONS)('%s is absent from every domain tree title bar', (command) => {
    const views = viewsOf(titleMenus().filter((e) => e.command === command));
    expect([...views].filter((v) => v !== 'modbench.toolbox')).toEqual([]);
  });

  // commands.md, Chrome: at most four icons.
  it('never exposes more than four navigation icons on any view, in any state', () => {
    const navEntries = titleMenus().filter((e) => (e.group ?? '').startsWith('navigation'));
    for (const view of viewsOf(navEntries)) {
      const entries = navEntries.filter((e) => e.when.includes(`view == ${view}`));
      const togglePairs = entries.filter((a) =>
        a.when.includes('!') && entries.some((b) => b !== a && a.when.replace('!', '') === b.when),
      ).length;
      expect(entries.length - togglePairs, `${view} exposes too many navigation icons`).toBeLessThanOrEqual(4);
    }
  });

  // commands.md, Chrome: Collapse All is on trees only.
  it('the Mods tree and the merged Plugins tree are the hierarchical ones', () => {
    const sidebarIds = present(pkg.contributes.views.modbench, "contributes.views['modbench']");
    const sidebar = sidebarIds.map((v) => v.id);
    expect(sidebar).toContain('modbench.modList');
    expect(sidebar).toContain('modbench.pluginListTree');
  });
});

describe('package.json offers no deploy', () => {
  it('contributes no setting that speaks of deploying or of where the game reads its load order', () => {
    const offering = Object.entries(pkg.contributes.configuration.properties)
      .filter(([key, setting]) => /deploy|purge|plugins\.?txt/i.test(`${key} ${setting.description ?? ''}`))
      .map(([key]) => key);
    expect(offering).toEqual([]);
  });
});

// A hardcoded "Modbench: " in `title` leaks into every context menu the command appears in.
// `category: "Modbench"` with a bare `title` lets VS Code compose the palette label while
// context menus render the bare title, so every command carries a category.
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
    const hidden = [...gestureIds].filter((id) => gatedFalse().has(id));
    expect(
      hidden,
      'commands.md, Entry points are not gestures: every gesture is also in the command palette.',
    ).toEqual([]);
  });

  // System commands (commands.md): Modbench runs each on its own trigger — no gesture, no entry
  // point, and no argument a picker could ever ask for.
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

// plugins.md, Menus and keys: the placement table, in VS Code's groups (open, change, create,
// source control, copy, then destroy), each item where its row's conditions hold.
describe('package.json Plugins menus, keys and palette follow plugins.md', () => {
  const PLUGINS_VIEW = 'view == modbench.pluginListTree';
  const inPluginsView = (menu: string): MenuEntry[] =>
    present(pkg.contributes.menus[menu], `contributes.menus['${menu}']`).filter((e) => requires(e.when, PLUGINS_VIEW));
  // The menu VS Code draws for a row: every entry whose `when` holds for the row's contextValue.
  const menuOf = (contextValue: string): [string, string][] => placed(
    inPluginsView('view/item/context').filter((e) => holds(e.when, { view: 'modbench.pluginListTree', viewItem: contextValue })));

  // VS Code adds Collapse All itself, as a navigation icon at order Number.MAX_SAFE_INTEGER.
  it('title bar: filter or clear, sort direction, filter records or clear, then create plugin, as icons', () => {
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

  it('title bar: slot 2 shows the one direction the view is not in', () => {
    const when = (command: string) =>
      present(inPluginsView('view/title').find((e) => e.command === command), command).when;
    expect(when('modbench.plugin.sortWinningAtTop')).toBe(`${PLUGINS_VIEW} && !modbench.plugin.winningAtTop && ${IN_AN_INSTANCE}`);
    expect(when('modbench.plugin.sortLosingAtTop')).toBe(`${PLUGINS_VIEW} && modbench.plugin.winningAtTop && ${IN_AN_INSTANCE}`);
  });

  // plugins.md, Reporting, stories 3 and 5: the untracked-plugin warning points at decompile by the
  // title the menus and the palette show.
  it('the untracked-plugin warning names decompile by its title', () => {
    const decompile = present(pkg.contributes.commands.find((c) => c.command === 'modbench.plugin.decompile'), 'decompile');
    expect(DECOMPILE_PLUGIN_TITLE).toBe(decompile.title);
  });

  it('the empty list\'s message names the title bar\'s create plugin', () => {
    const create = present(pkg.contributes.commands.find((c) => c.command === 'modbench.plugin.create'), 'create plugin');
    expect(NO_PLUGINS_MESSAGE).toContain(create.title);
    expect(NO_PLUGINS_MESSAGE).toContain('title bar');
  });

  it('plugin menu: reveal, enable or disable, create record, track, decompile, compile, copy value', () => {
    expect(menuOf('plugin disabled inUntrackedMod untracked editable')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.enable', '2_change'],
      ['modbench.mod.track', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
    expect(menuOf('plugin enabled inTrackedMod tracked editable')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.record.create', '3_create'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.plugin.compile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  // plugins.md, Menus and keys: compile (tracked). A disabled plugin is not active, so read-only
  // (story 4), and still compiles.
  it('plugin menu on a disabled tracked plugin: decompile and compile, and no record edit', () => {
    expect(menuOf('plugin disabled inTrackedMod tracked')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.enable', '2_change'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.plugin.compile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  // plugins.md, Reporting, story 5: an untracked plugin in a tracked mod is decompiled, not tracked.
  it('plugin menu on an untracked plugin in a tracked mod: decompile, and neither track nor compile', () => {
    expect(menuOf('plugin enabled inTrackedMod untracked editable')).toEqual([
      ['modbench.plugin.reveal', '1_open'],
      ['modbench.plugin.disable', '2_change'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  // plugins.md, Menus and keys: track is on the row of a plugin in a mod with no repository before
  // mEdit has described the plugin, since only the mod's folder decides it.
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

  // plugins.md, Menus and keys: track in a mod with no repository, decompile in a tracked mod,
  // compile on a tracked plugin.
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

  // plugins.md, Menus and keys, story 4: no record edit on an untracked plugin.
  it('record-type group menu: create record, only where its plugin is tracked, editable and the type is creatable', () => {
    expect(menuOf('recordType tracked editable creatable')).toEqual([['modbench.record.create', '3_create']]);
    expect(menuOf('recordType untracked editable creatable')).toEqual([]);
    expect(menuOf('recordType tracked creatable')).toEqual([]);
    expect(menuOf('recordType tracked editable')).toEqual([]);
  });

  // plugins.md, Create record, story 4: the Worldspace and Cell groups hold container records.
  it.each(['worldspaces', 'interiorCells'])('offers no create record on the %s group', (contextValue) => {
    expect(menuOf(contextValue).map(([command]) => command)).not.toContain('modbench.record.create');
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

  it.each([['untracked', 'untracked editable'], ['read-only', 'tracked']])('record menu on a record whose plugin is %s: no delete', (_what, conditions) => {
    expect(menuOf(`record ${conditions}`)).toEqual([
      [OPEN_TO_THE_SIDE, '1_open'],
      ['modbench.record.copy', '5_copy'],
      ['modbench.copyValue', '5_copy'],
    ]);
  });

  it.each(['recordType tracked editable', 'worldspaces', 'block', 'subBlock', 'interiorCells', 'placedGroup-persistent', 'indexing', 'error'])(
    'offers no record gesture on a row that stands for no record: %s', (contextValue) => {
      const recordGestures = menuOf(contextValue).filter(([command]) => command !== 'modbench.record.create');
      expect(recordGestures).toEqual([]);
    });

  // Only while the tree itself has focus: not in its filter box, a prompt, or the view's title bar.
  const ON_THE_TREE = `focusedView == modbench.pluginListTree && listFocus && !inputFocus && ${IN_AN_INSTANCE}`;

  // Enter is left to VS Code's own `list.select`, which opens the focused row as a click does.
  it('binds each key to its command while the Plugins tree has focus, and leaves Enter to VS Code', () => {
    const pluginsKeys = pkg.contributes.keybindings
      .filter((k) => k.when.startsWith('focusedView == modbench.pluginListTree'))
      .map(({ command, key, mac, when, args }) => ({ command, key, mac, when, args }));
    expect(pluginsKeys).toEqual([
      { command: 'modbench.plugin.enable', key: 'space', mac: undefined, when: `${ON_THE_TREE} && modbench.plugin.selectionToggle == enable`, args: undefined },
      { command: 'modbench.plugin.disable', key: 'space', mac: undefined, when: `${ON_THE_TREE} && modbench.plugin.selectionToggle == disable`, args: undefined },
      { command: 'modbench.pluginListTree.deleteHere', key: 'Delete', mac: 'cmd+backspace', when: `${ON_THE_TREE} && modbench.plugin.allDeletableRecords`, args: undefined },
      { command: 'modbench.copyValue', key: 'ctrl+c', mac: 'cmd+c', when: ON_THE_TREE, args: PLUGINS_KEY_ARGS },
    ]);
  });

  // No icon: Track is a one-time, deliberately weighty gesture (ADR-0007: "deliberate friction"),
  // not a quick inline action.
  it('never offers track as an inline or title icon', () => {
    const icons = [...inPluginsView('view/item/context'), ...inPluginsView('view/title')]
      .filter((e) => e.command === 'modbench.mod.track' && (e.group === 'inline' || e.group?.startsWith('navigation')));
    expect(icons).toEqual([]);
  });
});

// downloads.md, Menus and keys: "Row menu | install · view on Nexus · open · open `.meta` ·
// exclude or include · delete".
describe('package.json Downloads row menu order', () => {
  const downloadRowMenu = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => e.when.includes('view == modbench.downloads') && e.when.includes(String.raw`viewItem =~ /\bdownload\b/`));

  it('offers open unconditionally on every download row', () => {
    const entry = present(
      downloadRowMenu().find((e) => e.command === 'modbench.downloadedFile.open'),
      'a modbench.downloadedFile.open row-menu entry',
    );
    expect(entry.when).not.toContain('hasMeta');
  });

  it('offers open .meta only when the row\'s own contextValue says it has one', () => {
    const entry = present(
      downloadRowMenu().find((e) => e.command === 'modbench.downloadedFile.openMeta'),
      'a modbench.downloadedFile.openMeta row-menu entry',
    );
    expect(entry.when).toContain(String.raw`viewItem =~ /\bhasMeta\b/`);
  });

  // Exclude and include are two commands for one slot — mutually exclusive by their own `when` —
  // so the group each carries is the one place their shared position is checked.
  it('orders the row: install, view on Nexus, open, open .meta, exclude/include, delete', () => {
    const entries = downloadRowMenu();
    const slotOf = (command: string): number => {
      const group = present(entries.find((e) => e.command === command), `a ${command} row-menu entry`).group ?? '';
      return Number(present(/@(\d+)$/.exec(group)?.[1], `a numbered group for ${command} (got "${group}")`));
    };
    const exclude = slotOf('modbench.downloadedFile.exclude');
    const include = slotOf('modbench.downloadedFile.include');
    expect(include).toBe(exclude); // one slot, two mutually-exclusive commands

    const slots = [
      'modbench.mod.install', 'modbench.mod.viewOnNexus', 'modbench.downloadedFile.open',
      'modbench.downloadedFile.openMeta', 'modbench.downloadedFile.exclude', 'modbench.copyValue',
      'modbench.downloadedFile.delete',
    ].map(slotOf);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(slots.length); // strictly increasing, no ties outside exclude/include
  });

  // Ties the two halves together, as Mods' own enable/disable test does. Exclude's own clause
  // negates (`!(...excluded...)`), unlike enable/disable, so satisfies() reads the sign, not just
  // the flag name.
  it('an excluded row satisfies include\'s when-clause, and not exclude\'s — and vice versa', () => {
    const excludedRow = new DownloadNode(downloadRowFixture('foo.7z', { excluded: true }));
    const includedRow = new DownloadNode(downloadRowFixture('bar.7z', { excluded: false }));
    const exclude = present(
      downloadRowMenu().find((e) => e.command === 'modbench.downloadedFile.exclude'),
      'a modbench.downloadedFile.exclude row-menu entry',
    );
    const include = present(
      downloadRowMenu().find((e) => e.command === 'modbench.downloadedFile.include'),
      'a modbench.downloadedFile.include row-menu entry',
    );
    const conditionsOf = (when: string): { flag: string; negated: boolean }[] =>
      when.split('&&').map((clause) => clause.trim()).flatMap((clause) => {
        const negated = clause.startsWith('!(') && clause.endsWith(')');
        const inner = negated ? clause.slice(2, -1) : clause;
        const m = /^viewItem =~ \/\\b(\w+)\\b\/$/.exec(inner);
        return m ? [{ flag: present(m[1], 'a flag name'), negated }] : [];
      });
    const satisfies = (when: string, contextValue: string | undefined): boolean => {
      const tokens = present(contextValue, 'the row\'s own contextValue').split(' ');
      return conditionsOf(when).every(({ flag, negated }) => tokens.includes(flag) !== negated);
    };

    expect(satisfies(include.when, excludedRow.contextValue)).toBe(true);
    expect(satisfies(include.when, includedRow.contextValue)).toBe(false);
    expect(satisfies(exclude.when, includedRow.contextValue)).toBe(true);
    expect(satisfies(exclude.when, excludedRow.contextValue)).toBe(false);
  });
});

// common.md, A view, story 5: a view's keys wait for the tree itself, as the Explorer's do.
describe('package.json view keys', () => {
  const ON_THE_TREE = ['listFocus', '!inputFocus'];

  it('binds every view key only while the tree itself has focus — never in a prompt, the tree\'s find box or the view\'s title bar', () => {
    const rowKeys = pkg.contributes.keybindings.filter((k) => k.when.startsWith('focusedView == '));
    expect(rowKeys.length).toBeGreaterThan(0);
    const firesOffTheTree = rowKeys.filter((k) => !ON_THE_TREE.every((term) => requires(k.when, term)));
    expect(firesOffTheTree.map((k) => `${k.key} → ${k.command} (when: ${k.when})`)).toEqual([]);
  });

  it('binds no key to a filter', () => {
    const filterKeys = pkg.contributes.keybindings.filter((k) => k.command.endsWith('.filter'));
    expect(
      filterKeys.map((k) => `${k.key} → ${k.command}`),
      'common.md, The name filter, story 1: the filter is the title-bar control only, with no key — '
        + 'Ctrl+Alt+F and F3 stay VS Code\'s own Find on the tree.',
    ).toEqual([]);
  });

  it('binds no key outside a focused view or the record tab', () => {
    const unscoped = pkg.contributes.keybindings.filter((k) =>
      !k.when.startsWith('focusedView == ') && !k.when.startsWith("activeCustomEditorId == 'modbench.record' && "));
    expect(unscoped.map((k) => `${k.key} → ${k.command}`)).toEqual([]);
  });
});

// downloads.md, Menus and keys: "Keys | Delete: delete."
describe('package.json Downloads delete key', () => {
  it('binds Delete to modbench.downloadedFile.delete, scoped to the focused Downloads view', () => {
    const keybindings: { command: string; key: string; mac?: string; when: string }[] = pkg.contributes.keybindings;
    const entry = present(
      keybindings.find((k) => k.command === 'modbench.downloadedFile.delete'),
      'a Delete-key binding for modbench.downloadedFile.delete',
    );
    expect(entry.key).toBe('Delete');
    expect(entry.mac).toBe('cmd+backspace');
    expect(entry.when).toBe(`focusedView == modbench.downloads && listFocus && !inputFocus && ${IN_AN_INSTANCE}`);
  });
});

// downloads.md, Menus and keys: "Ctrl+C: copy value." and referenced-by.md, Menus and keys; each key
// hands the command its own view, which is how one command knows whose selection to copy.
describe('package.json Ctrl+C keys', () => {
  const COPY_KEYS = [
    'modbench.modList', 'modbench.pluginListTree', 'modbench.downloads', 'modbench.referencedByTree',
  ] as const;
  const copyKeys: { command: string; key: string; mac?: string; when: string; args?: unknown }[] =
    pkg.contributes.keybindings.filter((k: { command: string }) => k.command === 'modbench.copyValue');

  it.each(COPY_KEYS)('%s binds Ctrl+C to copy value, handing it its own view', (view) => {
    const entry = present(copyKeys.find((k) => k.when.startsWith(`focusedView == ${view} `)), `a Ctrl+C key for ${view}`);
    expect(entry.key).toBe('ctrl+c');
    expect(entry.mac).toBe('cmd+c');
    expect(entry.args).toEqual({ view });
  });

  it('binds no other Ctrl+C but the record grid\'s', () => {
    expect(copyKeys).toHaveLength(COPY_KEYS.length + 1);
  });
});

// commands.md, Record: a field gesture from the palette acts on the focused cell of the record tab
// in focus, and is in the palette only while one has focus, on the cell its menu is offered on.
describe('package.json field gestures\' palette entries', () => {
  // The active editor is a record tab and no sidebar or panel holds the focus: VS Code documents no
  // key for a webview's own focus (when-clause-contexts.md).
  const ON_A_RECORD_TAB = "activeCustomEditorId == 'modbench.record' && !sideBarFocus && !panelFocus && !auxiliaryBarFocus";
  const FIELD_PALETTE = [
    ['modbench.record.addElement', String.raw`modbench.record.focusedCellSection =~ /\barrayParent\b/`],
    ['modbench.record.removeElement', String.raw`modbench.record.focusedCellSection =~ /\barrayElement\b/`],
    ['modbench.record.moveElementUp', String.raw`modbench.record.focusedCellSection =~ /\barrayElement\b/ && modbench.record.focusedCellCanMoveUp`],
    ['modbench.record.moveElementDown', String.raw`modbench.record.focusedCellSection =~ /\barrayElement\b/ && modbench.record.focusedCellCanMoveDown`],
    ['modbench.record.editField', String.raw`modbench.record.focusedCellSection =~ /\bstringValue\b/`],
    ['modbench.record.openFieldValue', String.raw`modbench.record.focusedCellSection =~ /\bstringValue\b/`],
  ] as const;

  it.each(FIELD_PALETTE)('%s is in the palette only while a record tab has focus on a cell that holds: %s', (command, holds) => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === command);
    expect(entries.map((e) => e.when)).toEqual([`${ON_A_RECORD_TAB} && ${holds}`]);
  });
});

describe('package.json record grid keys, as editor.md\'s Menus and keys and its focused cell\'s story 7 place them', () => {
  const ON_THE_GRID = "activeCustomEditorId == 'modbench.record' && !sideBarFocus && !panelFocus && !auxiliaryBarFocus"
    + ' && !inputFocus && !modbench.record.focusedCellEditorOpen';
  const section = (name: string) => String.raw`modbench.record.focusedCellSection =~ /\b${name}\b/`;

  it('binds F2 to edit, Ctrl+C to copy value, Ctrl+X to cut, Ctrl+V to paste, Delete to remove or clear, Alt+Up and Alt+Down to move', () => {
    const gridKeys = pkg.contributes.keybindings.filter((k) => k.when.startsWith(ON_THE_GRID));
    expect(gridKeys).toEqual([
      { key: 'f2', command: 'modbench.recordGrid.editHere', when: `${ON_THE_GRID} && ${section('cell')}` },
      {
        key: 'ctrl+c', mac: 'cmd+c', command: 'modbench.copyValue', args: { view: 'modbench.recordGrid' },
        when: `${ON_THE_GRID} && modbench.record.focusedCellCopies`,
      },
      { key: 'ctrl+x', mac: 'cmd+x', command: 'modbench.recordGrid.cutHere', when: `${ON_THE_GRID} && ${section('editableCell')}` },
      { key: 'ctrl+v', mac: 'cmd+v', command: 'modbench.recordGrid.pasteHere', when: `${ON_THE_GRID} && ${section('editableCell')}` },
      {
        key: 'Delete', mac: 'cmd+backspace', command: 'modbench.record.removeElement',
        when: `${ON_THE_GRID} && ${section('arrayElement')}`,
      },
      {
        key: 'Delete', mac: 'cmd+backspace', command: 'modbench.recordGrid.clearHere',
        when: `${ON_THE_GRID} && ${section('editableCell')} && !(${section('arrayElement')})`,
      },
      {
        key: 'alt+up', command: 'modbench.record.moveElementUp',
        when: `${ON_THE_GRID} && ${section('arrayElement')} && modbench.record.focusedCellCanMoveUp`,
      },
      {
        key: 'alt+down', command: 'modbench.record.moveElementDown',
        when: `${ON_THE_GRID} && ${section('arrayElement')} && modbench.record.focusedCellCanMoveDown`,
      },
    ]);
  });

  it('acts on no key while the focused cell\'s editor is open', () => {
    const cell = {
      activeCustomEditorId: 'modbench.record', 'modbench.record.focusedCellSection': 'cell editableCell arrayElement',
      'modbench.record.focusedCellCopies': true, 'modbench.record.focusedCellCanMoveUp': true,
      'modbench.record.focusedCellCanMoveDown': true,
    };
    const gridKeys = pkg.contributes.keybindings.filter((k) => k.when.startsWith(ON_THE_GRID));
    expect(gridKeys.filter((k) => holds(k.when, cell)).map((k) => k.key)).toEqual(
      ['f2', 'ctrl+c', 'ctrl+x', 'ctrl+v', 'Delete', 'alt+up', 'alt+down']);
    expect(gridKeys.filter((k) => holds(k.when, { ...cell, 'modbench.record.focusedCellEditorOpen': true }))).toEqual([]);
  });

  it('removes an element with Delete, and clears only what is not an element', () => {
    const deletes = pkg.contributes.keybindings.filter((k) => k.when.startsWith(ON_THE_GRID) && k.key === 'Delete');
    const firing = (sections: string) => deletes
      .filter((k) => holds(k.when, { activeCustomEditorId: 'modbench.record', 'modbench.record.focusedCellSection': sections }))
      .map((k) => k.command);
    expect(firing('cell editableCell arrayElement')).toEqual(['modbench.record.removeElement']);
    expect(firing('cell editableCell')).toEqual(['modbench.recordGrid.clearHere']);
    expect(firing('cell')).toEqual([]);
  });
});

// commands.md, compile: Editor, context menu (plugin tracked and editable); editor.md, Menus and
// keys: the column header. The header's context hands the command its own plugin.
describe('package.json compile on the record tab', () => {
  it('is on the column header\'s menu of a compilable plugin, and nowhere else on the tab', () => {
    const webviewMenu = present(pkg.contributes.menus['webview/context'], "contributes.menus['webview/context']");
    expect(webviewMenu.filter((e) => e.command === 'modbench.plugin.compile').map((e) => e.when)).toEqual([
      String.raw`webviewId == 'modbench.record' && webviewSection =~ /\brecordHeader\b/ && editable`,
    ]);
    expect(pkg.contributes.menus['editor/title'] ?? []).toEqual([]);
  });
});

// commands.md, Principles: a palette entry takes the focused view's selection. Track is offered from
// Mods and from Plugins, each only while it is the view last selected in, whose selection the
// command takes.
describe('package.json track\'s palette entry', () => {
  it('is in the palette while Mods or Plugins has focus, was last selected in, and holds what track acts on', () => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === 'modbench.mod.track');
    expect(entries.map((e) => e.when)).toEqual([
      `focusedView == modbench.modList && ${IN_AN_INSTANCE} && modbench.mod.holdsUntrackedModWithPlugin`
      + ' && modbench.mod.trackRowsIn == modbench.modList'
      + ` || focusedView == modbench.pluginListTree && ${IN_AN_INSTANCE} && modbench.plugin.allInUntrackedMod`
      + ' && modbench.mod.trackRowsIn == modbench.pluginListTree',
    ]);
  });
});

// editor.md, Menus and keys: the row menus follow VS Code's groups, open, change, source control,
// copy, then destroy, and hold only the spec's items in its order.
describe('package.json record tab menus', () => {
  const menu = (): MenuEntry[] => present(pkg.contributes.menus['webview/context'], "contributes.menus['webview/context']");
  const tab = { webviewId: 'modbench.record', 'modbench.mod.tracked': ['Tracked'], 'modbench.mod.untracked': ['Untracked'] };
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
    ['an untracked mod', 'Untracked', false, ['modbench.mod.track', 'modbench.record.copy']],
    ['a tracked mod', 'Tracked', false, ['modbench.plugin.decompile', 'modbench.record.copy']],
    ['a tracked mod, editable', 'Tracked', true, [
      'modbench.plugin.decompile', 'modbench.plugin.compile', 'modbench.record.copy', 'modbench.record.delete',
    ]],
  ])('offers on the column of a plugin in %s only what applies', (_what, origin, editable, commands) => {
    expect(offered({ webviewSection: 'recordHeader', origin, editable })).toEqual(commands);
  });

  it('hides the internal command that follows a reference from the palette', () => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === 'modbench.record.openReference');
    expect(entries.map((e) => e.when)).toEqual(['false']);
  });
});

// editor.md, Menus and keys: the column header offers copy…, which picks the mode itself.
describe('package.json copy on the record tab', () => {
  it('is one entry on the column header\'s menu, and the only copy entry on the tab', () => {
    const webviewMenu = present(pkg.contributes.menus['webview/context'], "contributes.menus['webview/context']");
    expect(webviewMenu.filter((e) => e.command.startsWith('modbench.record.copy')).map((e) => [e.command, e.when])).toEqual([
      ['modbench.record.copy', String.raw`webviewId == 'modbench.record' && webviewSection =~ /\brecordHeader\b/`],
    ]);
  });
});

// plugins.md, Compile: from the palette, the one selected compilable plugin, or a pick of them.
describe('package.json compile\'s palette entry', () => {
  it('is in the palette while any plugin compiles', () => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === 'modbench.plugin.compile');
    expect(entries.map((e) => e.when)).toEqual([`${IN_AN_INSTANCE} && modbench.plugin.anyCompilable`]);
  });
});

// commands.md, No dead entries: each is listed only while the Plugins selection holds what it acts
// on, as its row menu does.
describe('package.json Plugins palette entries', () => {
  const PLUGINS_PALETTE = [
    ['modbench.plugin.reveal', 'modbench.plugin.singlePlugin'],
    ['modbench.plugin.decompile', 'modbench.plugin.allInTrackedMod'],
    ['modbench.record.create', 'modbench.plugin.singleCreatable'],
    ['modbench.record.delete', 'modbench.plugin.allDeletableRecords'],
    ['modbench.record.copy', 'modbench.plugin.allRecords'],
  ] as const;

  it.each(PLUGINS_PALETTE)('%s is in the palette only while the Plugins view has focus and its selection holds: %s', (command, holds) => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === command);
    // Record gestures take the selection of the view last selected in, so the entry waits for it to be this one.
    const lastSelected = command.startsWith('modbench.record.') && command !== 'modbench.record.create'
      ? ' && modbench.record.selectionIn == modbench.pluginListTree' : '';
    expect(entries.map((e) => e.when)).toEqual([
      `focusedView == modbench.pluginListTree${lastSelected} && ${IN_AN_INSTANCE} && ${holds}`,
    ]);
  });
});

// commands.md, No dead entries: each is listed only while the Downloads selection holds what it
// acts on.
describe('package.json Downloads palette entries', () => {
  const DOWNLOADS_PALETTE = [
    ['modbench.downloadedFile.open', 'modbench.downloadedFile.singleFile'],
    ['modbench.downloadedFile.openMeta', 'modbench.downloadedFile.singleFileWithMeta'],
    ['modbench.downloadedFile.delete', 'modbench.downloadedFile.holdsFile'],
    ['modbench.downloadedFile.exclude', 'modbench.downloadedFile.holdsIncluded'],
    ['modbench.downloadedFile.include', 'modbench.downloadedFile.holdsExcluded'],
  ] as const;

  it.each(DOWNLOADS_PALETTE)('%s is in the palette only while the Downloads view has focus and its selection holds: %s', (command, holds) => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === command);
    expect(entries.map((e) => e.when)).toEqual([`focusedView == modbench.downloads && ${IN_AN_INSTANCE} && ${holds}`]);
  });
});

// mods.md, Menus and keys, story 2: enable on a disabled row, disable on an enabled one — the
// row's own contextValue flag is what the menu reads to choose between the two commands.
describe('package.json Mods row menu — enable/disable by row state', () => {
  const modRowMenu = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => e.when.includes('view == modbench.modList') && e.when.includes(String.raw`viewItem =~ /\bmod\b/`));

  it('offers enable only on a disabled row, and disable only on an enabled one', () => {
    const enable = present(modRowMenu().find((e) => e.command === 'modbench.mod.enable'), 'a modbench.mod.enable row-menu entry');
    const disable = present(modRowMenu().find((e) => e.command === 'modbench.mod.disable'), 'a modbench.mod.disable row-menu entry');

    expect(enable.when).toContain(String.raw`viewItem =~ /\bdisabled\b/`);
    expect(disable.when).toContain(String.raw`viewItem =~ /\benabled\b/`);
    expect(disable.when).not.toContain(String.raw`\bdisabled\b`);
  });

  it('registers both IDs under the same view/item/context gate a mod row matches, whether or not it has a Nexus id', () => {
    for (const command of ['modbench.mod.enable', 'modbench.mod.disable']) {
      const entry = present(modRowMenu().find((e) => e.command === command), `a ${command} row-menu entry`);
      expect(entry.when).not.toContain('hasNexus');
    }
  });

  // Ties the two halves together: a real row's own contextValue is what the `when` string above
  // actually matches against, so this fails if either side drifts from the other.
  it('a disabled row\'s own contextValue matches enable\'s when-clause flags, and not disable\'s', () => {
    const disabledRow = new ModNode({ kind: 'mod', name: 'X', enabled: false });
    const enabledRow = new ModNode({ kind: 'mod', name: 'X', enabled: true });
    const enable = present(modRowMenu().find((e) => e.command === 'modbench.mod.enable'), 'a modbench.mod.enable row-menu entry');
    const disable = present(modRowMenu().find((e) => e.command === 'modbench.mod.disable'), 'a modbench.mod.disable row-menu entry');
    const flagsOf = (when: string): string[] =>
      [...when.matchAll(/\\b(\w+)\\b/g)].map((m) => present(m[1], 'a \\b...\\b flag name'));
    const tokensOf = (contextValue: string | undefined): string[] =>
      present(contextValue, 'the row\'s own contextValue').split(' ');
    const matches = (whenFlags: readonly string[], contextValue: string | undefined): boolean =>
      whenFlags.every((flag) => tokensOf(contextValue).includes(flag));

    expect(matches(flagsOf(enable.when), disabledRow.contextValue)).toBe(true);
    expect(matches(flagsOf(enable.when), enabledRow.contextValue)).toBe(false);
    expect(matches(flagsOf(disable.when), enabledRow.contextValue)).toBe(true);
    expect(matches(flagsOf(disable.when), disabledRow.contextValue)).toBe(false);
  });
});

// mods.md, Menus and keys: "Mod menu: … move… …" and "Separator menu: move… · add separator · …".
describe('package.json Move on the mod menu and the separator menu', () => {
  const modsViewMenu = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => e.when.includes('view == modbench.modList'));
  const moveEntries = (): MenuEntry[] => modsViewMenu().filter((e) => e.command === 'modbench.mod.move');
  const rowMatches = (when: string, contextValue: string | undefined): boolean => {
    const tokens = present(contextValue, "the row's own contextValue").split(' ');
    const exact = /viewItem == (\w+)/.exec(when)?.[1];
    if (exact !== undefined) return contextValue === exact;
    return [...when.matchAll(/\\b(\w+)\\b/g)].every((m) => tokens.includes(present(m[1], 'a \\b...\\b flag name')));
  };

  it('offers move on every mod row, enabled or not, and on every separator row', () => {
    const offeredOn = (contextValue: string | undefined): boolean =>
      moveEntries().some((e) => rowMatches(e.when, contextValue));

    expect(offeredOn(new ModNode({ kind: 'mod', name: 'X', enabled: true }).contextValue)).toBe(true);
    expect(offeredOn(new ModNode({ kind: 'mod', name: 'X', enabled: false, nexusId: '1' }).contextValue)).toBe(true);
    expect(offeredOn(new SeparatorNode({ kind: 'separator', name: 'S', enabled: true }, []).contextValue)).toBe(true);
    expect(offeredOn(new OverwriteNode(0, 'MO2').contextValue)).toBe(false);
  });
});

// mods.md, Menus and keys, story 5: copy value on the mod menu and the separator menu, under the
// catalog's one copy value id (commands.md, Record: copy value) — no second command for Mods.
describe('package.json Mods row menu — copy value', () => {
  const modsViewMenu = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => e.when.includes('view == modbench.modList'));
  const copyValueEntries = (): MenuEntry[] => modsViewMenu().filter((e) => e.command === 'modbench.copyValue');
  const rowMatches = (when: string, contextValue: string | undefined): boolean => {
    const tokens = present(contextValue, "the row's own contextValue").split(' ');
    const exact = /viewItem == (\w+)/.exec(when)?.[1];
    if (exact !== undefined) return contextValue === exact;
    return [...when.matchAll(/\\b(\w+)\\b/g)].every((m) => tokens.includes(present(m[1], 'a \\b...\\b flag name')));
  };

  it('offers copy value on every mod row, enabled or not, and on every separator row, but not Overwrite', () => {
    const offeredOn = (contextValue: string | undefined): boolean =>
      copyValueEntries().some((e) => rowMatches(e.when, contextValue));

    expect(offeredOn(new ModNode({ kind: 'mod', name: 'X', enabled: true }).contextValue)).toBe(true);
    expect(offeredOn(new ModNode({ kind: 'mod', name: 'X', enabled: false, nexusId: '1' }).contextValue)).toBe(true);
    expect(offeredOn(new SeparatorNode({ kind: 'separator', name: 'S', enabled: true }, []).contextValue)).toBe(true);
    expect(offeredOn(new OverwriteNode(0, 'MO2').contextValue)).toBe(false);
  });

  it('registers modbench.copyValue exactly once', () => {
    const registrations = pkg.contributes.commands.filter((c) => c.command === 'modbench.copyValue');
    expect(registrations).toHaveLength(1);
  });

  it('leaves the Referenced By tree\'s own copy value entry untouched', () => {
    const entry = present(
      pkg.contributes.menus['view/item/context']?.find(
        (e) => e.command === 'modbench.copyValue' && e.when.includes('referencedByTree')),
      'the Referenced By copy value entry',
    );
    expect(entry.when).toBe('view == modbench.referencedByTree && viewItem == referencedByReferrer');
    expect(entry.group).toBe('5_copy@1');
  });
});

// mods.md, Menus and keys: the placement table.
describe('package.json Mods title bar, menus, keys and palette follow mods.md', () => {
  const MODS_VIEW = 'view == modbench.modList';
  const inModsView = (menu: string): MenuEntry[] =>
    present(pkg.contributes.menus[menu], `contributes.menus['${menu}']`).filter((e) => requires(e.when, MODS_VIEW));
  const rowMenu = (row: string): MenuEntry[] => inModsView('view/item/context').filter((e) => e.when.includes(row));
  const MOD_ROW = String.raw`viewItem =~ /\bmod\b/`;

  // VS Code adds Collapse All itself, as a navigation icon at order Number.MAX_SAFE_INTEGER.
  it('title bar: filter or clear, then sort direction, as icons; install then create empty mod in the overflow', () => {
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
      ['modbench.mod.viewOnNexus', '1_open'],
      ['modbench.mod.enable', '2_change'],
      ['modbench.mod.disable', '2_change'],
      ['modbench.mod.move', '2_change'],
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
    expect(placed(rowMenu('viewItem == overwrite'))).toEqual([['modbench.mod.openFolder', '1_open']]);
  });

  const ONE_SEPARATOR = 'modbench.mod.selectionKind == separator && modbench.mod.singleRow';
  // Only while the tree itself has focus: not in its filter box, a prompt, or the view's title bar.
  const ON_THE_TREE = `focusedView == modbench.modList && listFocus && !inputFocus && ${IN_AN_INSTANCE}`;

  it('binds each key to its command while the Mods tree has focus', () => {
    const modsKeys = pkg.contributes.keybindings
      .filter((k) => k.when.startsWith('focusedView == modbench.modList'))
      .map(({ command, key, mac, when, args }) => ({ command, key, mac, when, args }));
    expect(modsKeys).toEqual([
      { command: 'modbench.mod.enable', key: 'space', mac: undefined, when: `${ON_THE_TREE} && modbench.mod.selectionToggle == enable`, args: undefined },
      { command: 'modbench.mod.disable', key: 'space', mac: undefined, when: `${ON_THE_TREE} && modbench.mod.selectionToggle == disable`, args: undefined },
      { command: 'modbench.mod.uninstall', key: 'Delete', mac: 'cmd+backspace', when: `${ON_THE_TREE} && modbench.mod.selectionKind == mod`, args: undefined },
      { command: 'modbench.separator.delete', key: 'Delete', mac: 'cmd+backspace', when: `${ON_THE_TREE} && modbench.mod.selectionKind == separator`, args: undefined },
      { command: 'modbench.separator.rename', key: 'f2', mac: 'enter', when: `${ON_THE_TREE} && ${ONE_SEPARATOR}`, args: undefined },
      { command: 'modbench.copyValue', key: 'ctrl+c', mac: 'cmd+c', when: ON_THE_TREE, args: MODS_KEY_ARGS },
    ]);
  });

  // commands.md, No dead entries: each is listed only while the selection holds what it acts on.
  const MODS_PALETTE = [
    ['modbench.mod.enable', 'modbench.mod.holdsDisabledMod'],
    ['modbench.mod.disable', 'modbench.mod.holdsEnabledMod'],
    ['modbench.mod.move', 'modbench.mod.selectionKind'],
    ['modbench.separator.add', 'modbench.mod.selectionKind && modbench.mod.singleRow'],
    ['modbench.separator.rename', ONE_SEPARATOR],
    ['modbench.separator.delete', 'modbench.mod.selectionKind == separator'],
    ['modbench.mod.uninstall', 'modbench.mod.selectionKind == mod'],
    ['modbench.mod.createEmpty', undefined],
    ['modbench.mod.install', undefined],
    ['modbench.mod.openFolder', 'modbench.mod.singleFolder'],
  ] as const;

  it.each(MODS_PALETTE)('%s is in the palette only while the Mods view has focus and its selection holds: %s', (command, holds) => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === command);
    const focused = `focusedView == modbench.modList && ${IN_AN_INSTANCE}`;
    expect(entries.map((e) => e.when)).toEqual([holds === undefined ? focused : `${focused} && ${holds}`]);
  });

  // commands.md, view on Nexus: Mods (mod has a Nexus id); Downloads (file has a Nexus id).
  it('offers view on Nexus in the palette only on the focused view whose row the command opens', () => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === 'modbench.mod.viewOnNexus');
    expect(entries.map((e) => e.when)).toEqual([
      `focusedView == modbench.modList && ${IN_AN_INSTANCE} && modbench.mod.nexusRowIn == modbench.modList`
      + ` || focusedView == modbench.downloads && ${IN_AN_INSTANCE} && modbench.mod.nexusRowIn == modbench.downloads`,
    ]);
  });

  it('the empty list\'s message names the overflow\'s own titles', () => {
    const overflowTitles = inModsView('view/title').filter((e) => groupOf(e) !== 'navigation')
      .map((e) => present(pkg.contributes.commands.find((c) => c.command === e.command), e.command).title);
    expect(overflowTitles.length).toBeGreaterThan(0);
    for (const title of overflowTitles) expect(NO_MODS_MESSAGE).toContain(title);
    expect(NO_MODS_MESSAGE).toContain('overflow');
  });
});

// editor.md, Opening, story 2: open to the side is on a referrer's menu as well.
describe('package.json open to the side', () => {
  it('reads Open to the Side', () => {
    expect(pkg.contributes.commands.find((c) => c.command === OPEN_TO_THE_SIDE)?.title).toBe('Open to the Side');
  });
});

describe('package.json open on Referenced By', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");

  it('puts open on the Referenced By referrer row\'s menu once', () => {
    const entry = present(
      contextMenus().find((e) =>
        e.command === OPEN_TO_THE_SIDE && e.when.includes('referencedByTree')),
      `a ${OPEN_TO_THE_SIDE} entry on the Referenced By tree`,
    );
    expect(entry.when).toBe('view == modbench.referencedByTree && viewItem == referencedByReferrer');
    expect(entry.group).toBe('1_open@1');
    expect(contextMenus().filter((e) => e.command === OPEN_TO_THE_SIDE && e.when.includes('referencedByTree')))
      .toHaveLength(1);
  });
});

// A row's Command ID cell holds its IDs in backticks; `-` and `?` hold none.
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

// commands.md, Entry points are not gestures: a title icon or a menu cannot name its view or pass
// an Option, so an internal command fires the gesture with them.
const OPEN_TO_THE_SIDE = 'modbench.record.openToSide';
const OPEN_REFERENCE = 'modbench.record.openReference';
const FILTER_ENTRY_POINTS = ['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads', 'modbench.referencedByTree']
  .flatMap((view) => [`${view}.filterHere`, `${view}.clearFilterHere`]);
const DELETE_ENTRY_POINTS = ['modbench.pluginListTree', 'modbench.referencedByTree'].map((view) => `${view}.deleteHere`);
const GRID_KEY_ENTRY_POINTS = ['editHere', 'cutHere', 'pasteHere', 'clearHere'].map((verb) => `modbench.recordGrid.${verb}`);
const ENTRY_POINTS = [...FILTER_ENTRY_POINTS, ...DELETE_ENTRY_POINTS, ...GRID_KEY_ENTRY_POINTS, OPEN_TO_THE_SIDE, OPEN_REFERENCE];

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

// editor-referenced-by.md, Menus and keys: the row menus follow open, change, copy, then destroy.
describe('package.json Referenced By menus and keys', () => {
  const menuOf = (viewItem: string) =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => e.when.startsWith(`view == modbench.referencedByTree && viewItem == ${viewItem}`))
      .map((e) => [e.command, e.group]);

  it('offers a referrer open to the side then copy value, and a plugin copy copy… then delete', () => {
    expect([menuOf('referencedByReferrer'), menuOf('referencedByHolder')]).toEqual([
      [[OPEN_TO_THE_SIDE, '1_open@1'], ['modbench.copyValue', '5_copy@1']],
      [['modbench.record.copy', '5_copy@1'], ['modbench.record.delete', '6_destroy@1']],
    ]);
  });

  it('binds Delete in the view only while every selected row is a plugin copy', () => {
    const keys = pkg.contributes.keybindings.filter((k) => k.command === 'modbench.referencedByTree.deleteHere');
    expect(keys.map(({ key, mac, when }) => ({ key, mac, when }))).toEqual([{
      key: 'Delete', mac: 'cmd+backspace',
      when: `focusedView == modbench.referencedByTree && listFocus && !inputFocus && ${IN_AN_INSTANCE} && modbench.referencedBy.allHolders`,
    }]);
  });
});
