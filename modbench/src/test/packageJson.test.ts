import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { present } from '../ports/present';
import { FOLDER_KEY, INSTANCE_READ_KEY } from '../folderContext';
import { IN_AN_INSTANCE, isRecord, requires } from './manifest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString, uriFile,
} from './vscodeMock';

// Only the Mods and Downloads row menus' own contextValue-vs-when tests below need a live
// ModNode/DownloadNode.
vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile },
}));

import { ModNode } from '../mods/ModListProvider';
import { DownloadNode } from '../downloads/DownloadsProvider';
import { downloadRowFixture } from './mo2/downloadRowFixture';

// This file's one parse point for package.json: checks the fields every read below assumes and
// throws rather than handing back an unproven shape.
interface ViewsWelcomeEntry { view: string; contents: string; when?: string; }
interface ViewEntry { id: string; name: string; when?: string; }
interface MenuEntry { command: string; when: string; group?: string; icon?: string; }
interface CommandEntry { command: string; title: string; category: string; icon?: string; }
interface KeybindingEntry { command: string; key: string; when: string; }
interface ViewsContainerEntry { id: string; }
interface SettingEntry { description?: string; }

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
  return isRecord(v) && isString(v.command) && isString(v.key) && isString(v.when);
}
function isViewsContainerEntry(v: unknown): v is ViewsContainerEntry {
  return isRecord(v) && isString(v.id);
}
function isSettingEntry(v: unknown): v is SettingEntry {
  return isRecord(v) && isOptionalString(v.description);
}

function parsePackageManifest(raw: unknown): PackageManifest {
  if (!isRecord(raw) || !isArrayOf(raw.activationEvents, isString)) {
    throw new Error('Expected package.json to have a string[] activationEvents.');
  }
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
    activationEvents: raw.activationEvents,
    contributes: {
      viewsWelcome, views, viewsContainers: { panel: viewsContainers.panel }, menus, commands, keybindings,
      configuration: { properties },
    },
  };
}

const pkg = parsePackageManifest(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')),
);

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
    expect(requires(undefined, IN_AN_INSTANCE)).toBe(false);
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

  it('is never a right-click entry point — modbench.record.showReferencedBy appears in no menu contribution', () => {
    const menus: Record<string, { command: string }[]> = pkg.contributes.menus;
    for (const [menuId, entries] of Object.entries(menus)) {
      expect(
        entries.some((e) => e.command === 'modbench.record.showReferencedBy'),
        `expected no "${menuId}" entry invoking modbench.record.showReferencedBy`,
      ).toBe(false);
    }
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

// VS Code has no view nesting/grouping within a container, so a "Plugins - " title prefix is the
// only available way to say Referenced By is sub-functionality of the one Plugins tree, not a
// sibling of equal standing (ADR-0017).
describe('package.json "Plugins - …" naming for Referenced By', () => {
  it('names the Referenced By view "Plugins - Referenced By"', () => {
    const referencedByViews = present(
      pkg.contributes.views.modbenchReferencedBy, "contributes.views['modbenchReferencedBy']",
    );
    const view = present(
      referencedByViews.find((v) => v.id === 'modbench.referencedByTree'),
      'the modbench.referencedByTree view entry',
    );
    expect(view.name).toBe('Plugins - Referenced By');
  });
});

describe('package.json retires modbench.viewMode and the second Plugins view', () => {
  const allViews = (): ViewEntry[] => [
    ...present(pkg.contributes.views.modbench, "contributes.views['modbench']"),
    ...present(pkg.contributes.views.modbenchReferencedBy, "contributes.views['modbenchReferencedBy']"),
  ];
  const allMenuEntries = (): { when?: string }[] => {
    const menus: Record<string, { when?: string }[]> = pkg.contributes.menus;
    return Object.values(menus).flat();
  };

  it('there is only one view named for plugins — modbench.pluginTree is gone', () => {
    expect(allViews().find((v) => v.id === 'modbench.pluginTree')).toBeUndefined();
    expect(allViews().filter((v) => v.name === 'Plugins')).toHaveLength(1);
    expect(
      present(allViews().filter((v) => v.name === 'Plugins')[0], 'the sole view named Plugins').id,
    ).toBe('modbench.pluginListTree');
  });

  it('Referenced By carries no gate at all — always present, like Mods/Plugins/Downloads', () => {
    const view = present(
      allViews().find((v) => v.id === 'modbench.referencedByTree'),
      'the modbench.referencedByTree view entry',
    );
    expect(view.when).toBeUndefined();
  });

  it('no view, menu entry or keybinding references modbench.viewMode anywhere', () => {
    const offendingViews = allViews().filter((v) => (v.when ?? '').includes('modbench.viewMode'));
    const offendingMenus = allMenuEntries().filter((e) => (e.when ?? '').includes('modbench.viewMode'));
    const keybindingsWithWhen: { when?: string }[] = pkg.contributes.keybindings;
    const offendingKeybindings = keybindingsWithWhen.filter((k) => (k.when ?? '').includes('modbench.viewMode'));
    expect(offendingViews).toEqual([]);
    expect(offendingMenus).toEqual([]);
    expect(offendingKeybindings).toEqual([]);
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
    expect(entryFor('modbench.plugin.filter').group).toBe('navigation@1');
  });

  it('places the record filter (setFilter/clearFilter) at slot 2', () => {
    expect(entryFor('modbench.setFilter').group).toBe('navigation@2');
    const clear = present(
      titleMenus().find((e) => e.command === 'modbench.clearFilter' && e.when.includes('modbench.pluginListTree')),
      'a view/title entry for modbench.clearFilter on modbench.pluginListTree',
    );
    expect(clear.group).toBe('navigation@2');
    expect(clear.when).toBe(`view == modbench.pluginListTree && modbench.filterActive && ${IN_AN_INSTANCE}`);
  });

  it('places New Plugin… at slot 3', () => {
    expect(entryFor('modbench.plugin.create').group).toBe('navigation@3');
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

// There is no Open Header button: xEdit parity (xeMainForm.pas — selecting a plugin node shows
// its File Header as a matter of course) means clicking a plugin row opens its header directly,
// through the row's own `.command`.
describe('package.json Open Header has no button of its own — row click replaces it', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");

  it('contributes no context-menu or inline entry for modbench.openHeader', () => {
    expect(contextMenus().filter((e) => e.command === 'modbench.openHeader')).toEqual([]);
  });

  it('modbench.openHeader itself is still declared — the row-click bridge command, not a button', () => {
    expect(pkg.contributes.commands.some((c) => c.command === 'modbench.openHeader')).toBe(true);
  });
});

describe('package.json filtering is one UX', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const commandOf = (): CommandEntry[] => pkg.contributes.commands;
  const commandTitle = (id: string) =>
    present(commandOf().find((c) => c.command === id), `a command entry for ${id}`);

  // commands.md, Chrome: the icons.
  const FILTERED_VIEWS = [
    ['modbench.modList', 'modbench.mod.filter'],
    ['modbench.pluginListTree', 'modbench.plugin.filter'],
    ['modbench.downloads', 'modbench.downloadedFile.filter'],
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
    expect(commandTitle('modbench.setFilter').icon).toBe('$(filter)');
  });

  // The filter is durable, so it needs a way out: the two-command + context-key toggle template,
  // so slot 1 shows exactly one of the pair at a time. The key is per view.
  const DURABLE_FILTERS = [
    ['modbench.modList', 'modbench.mod.filter', 'modbench.mod.clearFilter', 'modbench.mod.filterActive'],
    ['modbench.pluginListTree', 'modbench.plugin.filter', 'modbench.plugin.clearFilter', 'modbench.plugin.filterActive'],
    ['modbench.downloads', 'modbench.downloadedFile.filter', 'modbench.downloadedFile.clearFilter', 'modbench.downloadedFile.filterActive'],
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

  // `ctrl+F` means find-within-the-focused-surface everywhere else in VS Code. Trees left it
  // unbound when `list.find` moved to `ctrl+alt+F` in 1.89, so a per-view `focusedView` binding
  // conflicts with nothing.
  it.each(DURABLE_FILTERS)('%s opens its filter on ctrl+F while focused', (view, openCommand) => {
    const keybindings: { command: string; key: string; when: string }[] = pkg.contributes.keybindings;
    const entry = present(
      keybindings.find((k) => k.command === openCommand),
      `a ctrl+F binding for ${openCommand}`,
    );
    expect(entry.key).toBe('ctrl+f');
    expect(entry.when).toBe(`focusedView == ${view} && ${IN_AN_INSTANCE}`);
  });

  // Scoped to the focused view, never the container or the window: an unscoped ctrl+F would
  // shadow the editor's own Find for the whole workbench.
  it('never binds ctrl+F outside a specific focused view', () => {
    const keybindings: { command: string; key: string; when?: string }[] = pkg.contributes.keybindings;
    const unscoped = keybindings.filter((k) => k.key === 'ctrl+f' && !k.when?.startsWith('focusedView == '));
    expect(unscoped.map((k) => k.command)).toEqual([]);
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

describe('package.json offers no deploy, purge or run in the alpha', () => {
  const DEPLOYMENT_VERBS = ['deploy', 'purge', 'run', 'launch'];
  const isDeploymentCommand = (id: string): boolean =>
    DEPLOYMENT_VERBS.includes(id.split('.').at(-1)?.toLowerCase() ?? '');
  const menuCommands = (): string[] => Object.values(pkg.contributes.menus).flat().map((e) => e.command);

  it('contributes no deploy, purge or run command', () => {
    expect(pkg.contributes.commands.map((c) => c.command).filter(isDeploymentCommand)).toEqual([]);
  });

  it('places no deploy, purge or run command in any menu', () => {
    expect(menuCommands().filter(isDeploymentCommand)).toEqual([]);
  });

  it('binds no key to deploy, purge or run', () => {
    expect(pkg.contributes.keybindings.map((k) => k.command).filter(isDeploymentCommand)).toEqual([]);
  });

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

  // These do something only when invoked with a tree/webview argument the palette never supplies,
  // and none has an ambient fallback: left live, each is a silent no-op or a guaranteed error
  // toast. Exhaustive both ways, like EXPECTED_COMMANDS.
  const PALETTE_GATED = [
    'modbench.openHeader',
    // Each needs the clicked cell's own row/column identity from its
    // data-vscode-context — no ambient fallback worth a QuickPick-over-QuickPick, same posture as
    // the tree-row-gated commands below.
    'modbench.record.addElement',
    'modbench.record.removeElement',
    'modbench.record.moveElementUp',
    'modbench.record.moveElementDown',
    // ADR-0018: each needs the clicked cell's or VMAD row's own identity from its
    // data-vscode-context — no ambient fallback, same posture as the array ops above.
    'modbench.record.openFieldValue',
    'modbench.downloads.install',
    'modbench.mod.viewOnNexus',
    'modbench.downloadedFile.open',
    // Absent when the file has no .meta (its own context-menu `when`), and even offered it still
    // needs the clicked row's own identity — no ambient fallback.
    'modbench.downloadedFile.openMeta',
    // Has the Delete key's own ambient selection fallback; still gated here, as mod.enable below
    // is, because no palette entry names it.
    'modbench.downloadedFile.delete',
    'modbench.downloadedFile.exclude',
    'modbench.downloadedFile.include',
    'modbench.mod.openFolder',
    // Has the plural gesture's own ambient selection fallback; the Space key and the palette
    // entries are placed by a later slice.
    'modbench.mod.enable',
    'modbench.mod.disable',
    'modbench.separator.add',
    'modbench.mod.move',
    'modbench.mod.uninstall',
    'modbench.separator.rename',
    'modbench.separator.delete',
    'modbench.plugin.reveal',
    // Needs the clicked row's plugin name to resolve which mod folder to track.
    'modbench.plugin.track',
    // Needs the clicked row's plugin name — compiling "at main" from the palette with no
    // plugin in hand isn't a gesture worth a QuickPick-over-QuickPick (unlike modbench.saveAndCompile
    // itself, which falls back to one and stays palette-visible).
    'modbench.pluginListTree.compileAtMain',
    // Needs the clicked row's plugin name to resolve which mod folder (origin) to rebase —
    // same posture as Track/compileAtMain, no ambient fallback worth a QuickPick.
    'modbench.mod.rebaseEditBranch',
    // Each needs the clicked row's own identity (recordType node's plugin/recordType, or a
    // record row's own FormKey/plugin) — no ambient fallback worth a QuickPick-over-QuickPick,
    // same posture as the tree-row-gated commands above.
    'modbench.record.create',
    'modbench.record.delete',
    'modbench.record.renumber',
    // Reached from a plugins-tree record row or the record editor's column header, neither with an
    // ambient fallback worth a QuickPick-over-QuickPick.
    'modbench.record.copyAsOverride',
    'modbench.record.copyAsNewRecord',
  ] as const;

  it('gates exactly the commands that cannot work without a tree/webview argument out of the palette', () => {
    expect(PALETTE_GATED).toHaveLength(30);
    const gatedFalse = new Set(palette.filter((e) => e.when === 'false').map((e) => e.command));
    const missingGate = PALETTE_GATED.filter((c) => !gatedFalse.has(c));
    const unexpectedGate = [...gatedFalse].filter(
      (c) => !(PALETTE_GATED as readonly string[]).includes(c) && !(INTERNAL_COMMANDS as readonly string[]).includes(c),
    );
    expect(missingGate).toEqual([]);
    expect(unexpectedGate).toEqual([]);
  });

  // System commands (commands.md): Modbench runs each on its own trigger — no gesture, no entry
  // point, and (unlike PALETTE_GATED above) no argument a picker could ever ask for.
  const INTERNAL_COMMANDS = [
    'modbench.instance.putLoadOrder',
    'modbench.mod.sync',
    'modbench.plugin.sync',
  ] as const;

  it('gates every internal system command out of the palette too', () => {
    const systemCommandIds = catalogCommandIds(commandsMarkdown.slice(commandsMarkdown.indexOf('## System commands')));
    const notASystemCommand = INTERNAL_COMMANDS.filter((c) => !systemCommandIds.has(c));
    expect(
      notASystemCommand,
      notASystemCommand.map((c) => `${c} is not a Command ID in commands.md's System commands table.`).join('\n'),
    ).toEqual([]);
    const gatedFalse = new Set(palette.filter((e) => e.when === 'false').map((e) => e.command));
    const missingGate = INTERNAL_COMMANDS.filter((c) => !gatedFalse.has(c));
    expect(missingGate).toEqual([]);
  });
});

// Change FormID exists only on a master record in a tracked plugin, and is absent — not greyed,
// not offered-then-refused — everywhere else. Both halves are contextValue facts the row states
// for itself.
describe('package.json record-row context menu — renumber gated to native tracked rows', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");
  const whenOf = (command: string) =>
    present(contextMenus().find((e) => e.command === command), `a view/item/context entry for ${command}`).when;

  it('offers Change FormID only on viewItem == recordTracked', () => {
    expect(whenOf('modbench.record.renumber')).toBe('view == modbench.pluginListTree && viewItem == recordTracked');
  });

  it('offers Remove on override and untracked rows too', () => {
    expect(whenOf('modbench.record.delete')).toContain('recordOverride');
    expect(whenOf('modbench.record.delete')).toContain('recordUntracked');
  });

  it('offers both copy gestures on override and untracked rows too', () => {
    for (const command of ['modbench.record.copyAsOverride', 'modbench.record.copyAsNewRecord']) {
      expect(whenOf(command)).toContain('recordOverride');
      expect(whenOf(command)).toContain('recordUntracked');
    }
  });

  // Open Editor to the Side has a second entry on the Referenced By tree, so `whenOf`'s first-match
  // lookup cannot read it; it is pinned by exact equality below.
});

// Origin drift is absorbed automatically by the reconcile verb (ADR-0013) — there is nothing for
// a plugin row to be, or offer, beyond the two contextValues `PluginsTreeProvider` itself produces
// (`plugin`, `pluginImplicit`); there is no manual re-read gesture.
describe('package.json plugin-row context menu', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");
  const forPluginRows = () => contextMenus().filter((e) => e.when.includes('viewItem == plugin'));

  // Every command reachable from a plugin row, listed, with exactly one contextValue (`plugin`).
  // Open Header has no entries: it opens via row click, not a menu entry.
  it('every plugin-row command states exactly which plugin rows it applies to', () => {
    expect(forPluginRows().map((e) => [e.command, e.when])).toEqual([
      ['modbench.plugin.reveal', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.plugin.track', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.saveAndCompile', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.pluginListTree.compileAtMain', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.mod.rebaseEditBranch', 'view == modbench.pluginListTree && viewItem == plugin'],
    ]);
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
      'modbench.downloads.install', 'modbench.mod.viewOnNexus', 'modbench.downloadedFile.open',
      'modbench.downloadedFile.openMeta', 'modbench.downloadedFile.exclude', 'modbench.downloadedFile.delete',
    ].map(slotOf);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(slots.length); // strictly increasing, no ties outside exclude/include
  });

  // Ties the two halves together, as Mods' own enable/disable test does. Exclude's own clause
  // negates (`!(...hidden...)`), unlike enable/disable, so satisfies() reads the sign, not just
  // the flag name.
  it('an excluded row satisfies include\'s when-clause, and not exclude\'s — and vice versa', () => {
    const excludedRow = new DownloadNode(downloadRowFixture('foo.7z', { hidden: true }));
    const includedRow = new DownloadNode(downloadRowFixture('bar.7z', { hidden: false }));
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
    expect(entry.when).toBe(`focusedView == modbench.downloads && ${IN_AN_INSTANCE}`);
  });
});

// mods.md, Menus and keys, story 3: enable on a disabled row, disable on an enabled one — the
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

  // Enable and disable are one slot, mutually exclusive by their own `when` — same posture as
  // Downloads' exclude/include pair.
  it('shares one slot between enable and disable', () => {
    const entries = modRowMenu();
    const slotOf = (command: string): number => {
      const group = present(entries.find((e) => e.command === command), `a ${command} row-menu entry`).group ?? '';
      return Number(present(/@(\d+)$/.exec(group)?.[1], `a numbered group for ${command} (got "${group}")`));
    };
    expect(slotOf('modbench.mod.enable')).toBe(slotOf('modbench.mod.disable'));
  });

  // mods.md's row order: "open folder · view on Nexus · enable or disable · move… · add
  // separator · … · uninstall" — a change gesture between the last read (view on Nexus) and the
  // destroy group (uninstall), never after it.
  it('sits after view on Nexus and before uninstall', () => {
    const entries = modRowMenu();
    const slotOf = (command: string): number => {
      const group = present(entries.find((e) => e.command === command), `a ${command} row-menu entry`).group ?? '';
      return Number(present(/@(\d+)$/.exec(group)?.[1], `a numbered group for ${command} (got "${group}")`));
    };
    const viewOnNexus = slotOf('modbench.mod.viewOnNexus');
    const enable = slotOf('modbench.mod.enable');
    const disable = slotOf('modbench.mod.disable');
    const uninstall = slotOf('modbench.mod.uninstall');

    expect(enable).toBeGreaterThan(viewOnNexus);
    expect(disable).toBeGreaterThan(viewOnNexus);
    expect(enable).toBeLessThan(uninstall);
    expect(disable).toBeLessThan(uninstall);
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

// ADR-0007: the Track gesture's own menu contribution.
describe('package.json per-plugin Track', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");

  it('sits below the other row actions in the same row-action group', () => {
    const entry = present(
      contextMenus().find((e) => e.command === 'modbench.plugin.track'),
      'the modbench.plugin.track context-menu entry',
    );
    expect(entry.group).toBe('pluginActions@2');
  });

  // No icon: Track is a one-time, deliberately weighty gesture (ADR-0007: "deliberate friction"),
  // not a quick inline action.
  it('never appears as an inline or navigation icon', () => {
    const inline = contextMenus().filter((e) => e.command === 'modbench.plugin.track' && e.group === 'inline');
    const trackTitleMenus = present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
    const title = trackTitleMenus.filter((e) => e.command === 'modbench.plugin.track');
    expect([...inline, ...title]).toEqual([]);
  });
});

// "Open Editor to the Side" is reachable from the Referenced By tree's group rows and from
// the Plugins tree's record and placed-reference rows — single or multi-selected.
describe('package.json "Open Editor to the Side" reachable from Plugins tree record rows', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");

  it('offers modbench.openEditorBeside on every record and placed-reference row', () => {
    const entry = present(
      contextMenus().find((e) =>
        e.command === 'modbench.openEditorBeside' && e.when.includes('modbench.pluginListTree')),
      'a modbench.openEditorBeside entry on the Plugins tree',
    );
    expect(entry.when).toBe(
      'view == modbench.pluginListTree && (viewItem == recordTracked || viewItem == recordUntracked'
      + ' || viewItem == recordOverride || viewItem == recordImmutable || viewItem == refr || viewItem == refrImmutable)');
  });

  it('leaves the Referenced By group row\'s own existing entry untouched', () => {
    const entry = present(
      contextMenus().find((e) =>
        e.command === 'modbench.openEditorBeside' && e.when.includes('referencedByTree')),
      'a modbench.openEditorBeside entry on the Referenced By tree',
    );
    expect(entry.when).toBe('view == modbench.referencedByTree && viewItem == referencedByGroup');
    expect(entry.group).toBe('modbench@2');
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

// The reverse of the forward gate below: a `built` row naming an ID nothing registers.
function catalogBuiltCommandIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  let idColumn: number | undefined;
  let statusColumn: number | undefined;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      idColumn = undefined;
      statusColumn = undefined;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (idColumn === undefined) {
      idColumn = cells.indexOf('Command ID');
      statusColumn = cells.indexOf('Status');
      continue;
    }
    if (idColumn === -1 || statusColumn === undefined || statusColumn === -1) continue;
    if (cells[statusColumn] !== 'built') continue;
    for (const match of (cells[idColumn] ?? '').matchAll(/`(modbench\.[\w.]+)`/g)) {
      ids.add(present(match[1], 'the backticked Command ID'));
    }
  }
  return ids;
}

const builtCatalog = catalogBuiltCommandIds(commandsMarkdown);

// The gate's only exception. Each line is a gesture whose merge into its catalog ID belongs to
// another ticket, and that ticket deletes the line.
const LEGACY_GESTURES = [
  { gesture: 'install', removedBy: '#959', ids: ['modbench.downloads.install'] },
  { gesture: 'record open', removedBy: '#963', ids: ['modbench.openEditor', 'modbench.openEditorBeside', 'modbench.openHeader', 'modbench.openCompare'] },
  { gesture: 'compile', removedBy: '#961', ids: ['modbench.saveAndCompile', 'modbench.pluginListTree.compileAtMain'] },
  { gesture: 'copy', removedBy: '#962', ids: ['modbench.record.copyAsOverride', 'modbench.record.copyAsNewRecord'] },
  { gesture: 'record filter', removedBy: '#964', ids: ['modbench.setFilter', 'modbench.clearFilter', 'modbench.setFilterFromDocument'] },
] as const;

describe('package.json registers every command under its catalog Command ID', () => {
  const registered = pkg.contributes.commands.map((c) => c.command);
  const legacy = new Set<string>(LEGACY_GESTURES.flatMap((g) => g.ids));

  it('reads the Command ID column of every catalog table', () => {
    expect(catalog).toContain('modbench.mod.enable');
    expect(catalog).toContain('modbench.downloadedFile.hideExcluded');
    expect(catalog).toContain('modbench.plugin.sync');
  });

  it('registers no ID that is in neither the catalog nor the legacy list', () => {
    const offenders = registered.filter((id) => !catalog.has(id) && !legacy.has(id));
    expect(
      offenders,
      offenders.map((id) => `${id} is not a Command ID in docs/architecture/commands.md. The catalog is the `
        + 'source: register the gesture under the ID its row gives it.').join('\n'),
    ).toEqual([]);
  });

  it('lists only legacy IDs that are registered, so a landed merge deletes its line', () => {
    const stale = [...legacy].filter((id) => !registered.includes(id));
    expect(stale, `${stale.join(', ')} is not registered: delete it from LEGACY_GESTURES.`).toEqual([]);
  });

  it('registers every Command ID whose row is built', () => {
    const missing = [...builtCatalog].filter((id) => !registered.includes(id));
    expect(
      missing,
      missing.map((id) => `${id} is \`built\` in commands.md but package.json does not register it.`).join('\n'),
    ).toEqual([]);
  });
});

// The Plugins PRD retitles the record lifecycle menus, so their titles are its to set.
const TITLES_SET_ELSEWHERE = new Set(['modbench.record.create', 'modbench.record.delete', 'modbench.record.renumber']);

const wordsOf = (camel: string): string[] => camel.split(/(?=[A-Z])/).map((w) => w.toLowerCase());

describe('package.json palette titles are the verb and the object', () => {
  const titled = pkg.contributes.commands.filter((c) => catalog.has(c.command) && !TITLES_SET_ELSEWHERE.has(c.command));

  it.each(titled.map((c) => [c.command, c.title]))('%s is titled "%s"', (id, title) => {
    const [, object = '', verb = ''] = present(
      /^modbench\.(\w+)\.(\w+)$/.exec(id) ?? undefined, `${id} as modbench.<object>.<verb>`);
    const titleWords = title.replace('…', '').toLowerCase().split(/\s+/);
    const objectWords = wordsOf(object);
    const noun = present(objectWords.pop(), `the noun of ${object}`);
    expect(titleWords, `the title of ${id} names the verb`).toEqual(expect.arrayContaining(wordsOf(verb)));
    expect(titleWords, `the title of ${id} names the object`).toEqual(expect.arrayContaining(objectWords));
    expect(titleWords.some((w) => w === noun || w === `${noun}s`), `the title of ${id} names the ${noun}`).toBe(true);
  });
});
