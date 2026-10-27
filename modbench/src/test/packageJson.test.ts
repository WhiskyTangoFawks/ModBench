import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { present } from '../ports/present';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString, EventEmitter, Uri,
} from './vscodeMock';
import { ANY_SOURCE_MOD_KEY, FOLDER_KEY, LOGGED_IN_KEY, HAS_REPOSITORY_KEY, INSTANCE_READ_KEY, REPOSITORY_SET_UP_KEY, IN_AN_INSTANCE, holds, isRecord, requires } from './manifest';
import { catalogCommandIds, COMMANDS_MARKDOWN, GESTURES_MARKDOWN, SYSTEM_COMMANDS_MARKDOWN, SPECIFIED_AHEAD_OF_CODE, RETIRED_AHEAD_OF_CODE } from './commandsCatalog';

const groupOf = (entry: MenuEntry): string => (entry.group ?? '').split('@')[0] ?? '';
const orderOf = (entry: MenuEntry): number => Number((entry.group ?? '').split('@')[1] ?? Number.NaN);
const drawOrderKey = (group: string): string => (group === 'navigation' ? '' : group);
const placed = (entries: readonly MenuEntry[]): [string, string][] =>
  [...entries]
    .sort((a, b) => drawOrderKey(groupOf(a)).localeCompare(drawOrderKey(groupOf(b))) || orderOf(a) - orderOf(b))
    .map((e) => [e.command, groupOf(e)]);

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, MarkdownString, EventEmitter,
  Uri,
}));

import { OpenRows } from '../mods/openRows';
import { ModListProvider, ModNode, OverwriteNode, SeparatorNode } from '../mods/ModListProvider';
import { MANIFEST } from './scanSource';
import { NO_MOD_STATUSES } from './noModStatuses';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { CELL_VALUE_SETTING } from '../mods/conflictTableEditor';
import { CONFLICT_CELL_VALUES } from '../wire/conflictTable';
import { NO_PLUGINS_MESSAGE } from '../plugins/PluginsTreeProvider';
import { GREY_INACTIVE_FILES_SETTING } from '../mods/inactiveFiles';
import { indicatorSetting, MOD_INDICATORS, PUBLISHER_TAG_INDICATOR } from '../mods/modIndicators';

interface ViewsWelcomeEntry { view: string; contents: string; when?: string; }
interface ViewEntry { id: string; name: string; when?: string; }
interface MenuEntry { command: string; when: string; group?: string; icon?: string; }
interface CommandEntry { command: string; title: string; category: string; icon?: string; }
interface KeybindingEntry { command: string; key: string; when: string; mac?: string; args?: unknown; }
interface SettingEntry { description?: string; type?: unknown; default?: unknown; enum?: unknown; scope?: unknown; }
interface ColorEntry { id: string; }
interface CustomEditorEntry { viewType: string; }
interface WalkthroughStep { id: string; title: string; description: string; media: { markdown: string }; completionEvents: string[]; }
interface WalkthroughEntry { id: string; steps: WalkthroughStep[]; }
interface UntrustedWorkspaces { supported: unknown; description?: string; }

interface PackageManifest {
  activationEvents: string[];
  extensionDependencies: unknown;
  capabilities: { untrustedWorkspaces: UntrustedWorkspaces };
  contributes: {
    viewsWelcome: ViewsWelcomeEntry[];
    views: Record<string, ViewEntry[]>;
    menus: Record<string, MenuEntry[]>;
    commands: CommandEntry[];
    keybindings: KeybindingEntry[];
    configuration: { properties: Record<string, SettingEntry> };
    colors: ColorEntry[];
    customEditors: CustomEditorEntry[];
    walkthroughs: WalkthroughEntry[];
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
function isSettingEntry(v: unknown): v is SettingEntry {
  return isRecord(v) && isOptionalString(v.description);
}
function isColorEntry(v: unknown): v is ColorEntry {
  return isRecord(v) && isString(v.id);
}
function isCustomEditorEntry(v: unknown): v is CustomEditorEntry {
  return isRecord(v) && isString(v.viewType);
}
function isWalkthroughStep(v: unknown): v is WalkthroughStep {
  return isRecord(v) && isString(v.id) && isString(v.title) && isString(v.description) && isRecord(v.media) && isString(v.media.markdown)
    && isArrayOf(v.completionEvents, isString);
}
function isWalkthroughEntry(v: unknown): v is WalkthroughEntry {
  return isRecord(v) && isString(v.id) && isArrayOf(v.steps, isWalkthroughStep);
}
function capabilitiesOf(raw: unknown): PackageManifest['capabilities'] {
  if (!isRecord(raw) || !isRecord(raw.untrustedWorkspaces) || !isOptionalString(raw.untrustedWorkspaces.description)) {
    throw new Error('Expected package.json capabilities.untrustedWorkspaces to be { supported, description? }.');
  }
  return { untrustedWorkspaces: { supported: raw.untrustedWorkspaces.supported, description: raw.untrustedWorkspaces.description } };
}

function parsePackageManifest(raw: unknown): PackageManifest {
  if (!isRecord(raw) || !isArrayOf(raw.activationEvents, isString)) {
    throw new Error('Expected package.json to have a string[] activationEvents.');
  }
  const { contributes } = raw;
  if (!isRecord(contributes)) throw new Error('Expected package.json to have a contributes object.');
  const { viewsWelcome, views, menus, commands, keybindings, configuration, colors, customEditors, walkthroughs } = contributes;
  if (!isArrayOf(viewsWelcome, isViewsWelcomeEntry)) {
    throw new Error('Expected contributes.viewsWelcome to be an array of { view, contents, when? }.');
  }
  if (!isRecordOfArrays(views, isViewEntry)) {
    throw new Error('Expected contributes.views to be a map of { id, name, when? } arrays.');
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
  if (!isArrayOf(walkthroughs, isWalkthroughEntry)) {
    throw new Error('Expected contributes.walkthroughs to be an array of { id, steps: { id, title, media: { markdown }, completionEvents }[] }.');
  }
  const { properties } = configuration;
  return {
    activationEvents: raw.activationEvents,
    extensionDependencies: raw.extensionDependencies,
    capabilities: capabilitiesOf(raw.capabilities),
    contributes: {
      viewsWelcome, views, menus, commands, keybindings,
      configuration: { properties }, colors, customEditors, walkthroughs,
    },
  };
}

const REPOSITORY = 'https://github.com/WhiskyTangoFawks/ModBench';
const pkg = parsePackageManifest(
  JSON.parse(readFileSync(MANIFEST, 'utf8')),
);

type Context = Parameters<typeof holds>[1];
const inInstance: Context = { [FOLDER_KEY]: 'instance' };
const GIT_INIT = 'modbench.modlist.gitInit';
const UPDATE_MANIFEST = 'modbench.mod.updateManifest';
const RESTORE_FROM_MANIFEST = 'modbench.mod.restoreFromManifest';
const CHECK_FOR_UPDATES_HERE = 'modbench.modList.checkForUpdatesHere';
const EVERY_MOD_ENTRY_POINTS = ['modbench.modList.updateManifestHere', 'modbench.modList.restoreFromManifestHere'];
type Key = { key: string; mac?: string; command: string };
const keysFiring = (context: Context): Key[] =>
  pkg.contributes.keybindings.filter((k) => holds(k.when, context)).map(({ key, mac, command }) => ({ key, mac, command }));
const expectKeysFiring = (context: Context, expected: readonly Key[]): void => {
  const firing = keysFiring(context);
  expect(firing).toHaveLength(expected.length);
  expect(firing).toEqual(expect.arrayContaining([...expected]));
};
const offeredIn = (entries: readonly MenuEntry[], context: Context): string[] =>
  placed(entries.filter((e) => holds(e.when, context))).map(([command]) => command);
const contextOf = (node: { contextValue?: string }): string => present(node.contextValue, 'the row\'s own contextValue');
const without = (facts: Context, fact: string): Context => Object.fromEntries(Object.entries(facts).filter(([key]) => key !== fact));
const eachMissingFact = (rows: readonly (readonly [string, Context])[]) =>
  rows.flatMap(([command, facts]) => Object.keys(facts).map((fact) => [command, fact, facts] as const));
const paletteOffers = (command: string, context: Context): boolean =>
  present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
    .filter((e) => e.command === command).some((e) => holds(e.when, context));

const OPEN_DEPLOYMENT_FOLDER_SETTING = 'modbench.settings.openDeploymentFolderHere';
const OPEN_PINNED = 'modbench.record.openPinned';
const REFERENCED_BY = 'modbench.record.referencedBy';

describe('package.json activation', () => {
  it('auto-activates on startup so the Activity Bar icon is never stuck hidden', () => {
    expect(pkg.activationEvents).toContain('onStartupFinished');
  });
});

describe('package.json getting started (user-docs.md, The walkthrough)', () => {
  const steps = pkg.contributes.walkthroughs.flatMap((walkthrough) => walkthrough.steps);
  const commands = new Set(pkg.contributes.commands.map(({ command }) => command));
  const views = new Set(Object.values(pkg.contributes.views).flat().map(({ id }) => id));
  const isVsCodes = (subject: string): boolean => subject.startsWith('workbench.');
  const isCommand = (subject: string): boolean => commands.has(subject) || isVsCodes(subject) || views.has(subject.replace(/\.focus$/, ''));
  const OWNERS: Record<string, (subject: string) => boolean> = {
    onCommand: isCommand,
    onView: (subject) => views.has(subject) || isVsCodes(subject),
    onContext: (subject) => [FOLDER_KEY, INSTANCE_READ_KEY, ANY_SOURCE_MOD_KEY, HAS_REPOSITORY_KEY, REPOSITORY_SET_UP_KEY].some((key) => subject.startsWith(`${key} `)),
    onLink: (subject) => subject.startsWith(`${REPOSITORY}/blob/main/docs/wiki/`),
  };
  const owned = (event: string): boolean => {
    const [kind = '', subject = ''] = event.split(/:(.*)/s);
    return OWNERS[kind]?.(subject) ?? false;
  };
  const linkedCommands = (description: string): string[] => [...description.matchAll(/\(command:([^)?]+)/g)].map(([, command = '']) => command);

  it('is one walkthrough, the one VS Code opens on install', () => {
    expect(pkg.contributes.walkthroughs).toHaveLength(1);
  });

  it('ticks each step on a command, view or context of Modbench or VS Code, or a link into the repository (story 3)', () => {
    expect(steps.filter((step) => step.completionEvents.length === 0 || !step.completionEvents.every(owned)).map(({ id }) => id)).toEqual([]);
  });

  it('ticks the git init step when git init has set the repository up (story 1)', () => {
    expect(steps.find(({ id }) => id === 'gitInit')?.completionEvents).toEqual([`onContext:${REPOSITORY_SET_UP_KEY} == true`]);
  });

  it('ticks the agent step when I list my MCP servers, where VS Code Chat already has Modbench, or open the page that sets up another agent (story 3)', () => {
    expect(steps.find(({ id }) => id === 'agent')?.completionEvents).toEqual([
      'onCommand:workbench.mcp.listServer', `onLink:${REPOSITORY}/blob/main/docs/wiki/agent.md`,
    ]);
  });

  it('ticks the decompile step when a source mod exists (story 3)', () => {
    expect(steps.find(({ id }) => id === 'decompile')?.completionEvents).toEqual([`onContext:${ANY_SOURCE_MOD_KEY} == true`]);
  });

  it('links each step only to commands that exist', () => {
    expect(steps.flatMap(({ description }) => linkedCommands(description)).filter((command) => !isCommand(command))).toEqual([]);
  });

  it('shows each step a markdown file the extension ships', () => {
    expect(steps.filter(({ media }) => !existsSync(path.join(__dirname, '..', '..', media.markdown))).map(({ id }) => id)).toEqual([]);
  });
});

const VIEWS_OF_THE_INSTANCE = ['modbench.toolbox', 'modbench.modList', 'modbench.pluginListTree', 'modbench.downloads'];

describe('package.json in an untrusted folder (user-docs.md, The walkthrough, story 4)', () => {
  const OFF_UNTIL_TRUSTED = 'Modbench is off until you trust this folder. It changes your mod files and runs git here.';

  it('stays in Restricted Mode and says why it is off', () => {
    expect(pkg.capabilities.untrustedWorkspaces).toEqual({ supported: 'limited', description: OFF_UNTIL_TRUSTED });
  });

  const beforeTrust: Context = { [FOLDER_KEY]: 'untrustedInstance', isWorkspaceTrusted: false };

  it('offers no command in the palette before trust, since Modbench registers none until it starts', () => {
    const palette = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']");
    const offered = pkg.contributes.commands.map(({ command }) => command).filter((command) => {
      const entries = palette.filter((e) => e.command === command);
      return entries.length === 0 || entries.some((e) => holds(e.when, beforeTrust));
    });
    expect(offered).toEqual([]);
  });

  it('binds no key before trust, since Modbench registers no command until it starts', () => {
    expect(keysFiring(beforeTrust)).toEqual([]);
  });

  it('depends on no extension, which Restricted Mode could turn off and Modbench with it', () => {
    expect(pkg.extensionDependencies).toBeUndefined();
  });

  it.each(VIEWS_OF_THE_INSTANCE)('%s says, in an untrusted instance, that Modbench is off until it is trusted, with a link to trust it', (view) => {
    expect(pkg.contributes.viewsWelcome.filter((w) => w.view === view && w.when === `${FOLDER_KEY} == untrustedInstance`).map((w) => w.contents))
      .toEqual([`${OFF_UNTIL_TRUSTED}\n[Trust This Folder](command:workbench.trust.manage)`]);
  });
});

describe('package.json outside an instance', () => {
  const isNotAnInstance = `${FOLDER_KEY} == notAnInstance`;

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
});

describe('package.json Toolbox view', () => {
  const sidebarViews = (): ViewEntry[] => present(pkg.contributes.views.modbench, "contributes.views['modbench']");

  it('is the first view in the Modbench container, above Mods, Plugins and Downloads (toolbox.md, mods.md, plugins.md, downloads.md)', () => {
    expect(sidebarViews().map((view) => view.id).slice(0, 4)).toEqual(['modbench.toolbox', 'modbench.modList', 'modbench.pluginListTree', 'modbench.downloads']);
  });

  const toolboxTitle = (loggedIn: boolean) =>
    placed(present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']")
      .filter((e) => holds(e.when, { view: 'modbench.toolbox', [FOLDER_KEY]: 'instance', [LOGGED_IN_KEY]: loggedIn })));

  it('has refresh as its one title icon, then open settings and log in in its overflow while logged out', () => {
    expect(toolboxTitle(false)).toEqual([
      ['modbench.instance.refresh', 'navigation'], ['modbench.settings.open', 'settings'], ['modbench.instance.logIn', 'settings'],
    ]);
  });

  it('has log out in the overflow in place of log in while logged in', () => {
    expect(toolboxTitle(true)).toEqual([
      ['modbench.instance.refresh', 'navigation'], ['modbench.settings.open', 'settings'], ['modbench.instance.logOut', 'settings'],
    ]);
  });

  it('declares the deployment folder as a setting a workspace holds, which no commit holds (deployment-hardlink.md, The deployment folder, story 1)', () => {
    const setting = present(pkg.contributes.configuration.properties['modbench.deployment.folder'], 'the deployment folder setting');
    expect(setting.scope).toBe('machine-overridable');
  });

  it('offers switch, and only switch, on the Profile row\'s menu', () => {
    const profileMenu = present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => requires(e.when, 'view == modbench.toolbox') && requires(e.when, 'viewItem == profile'));

    expect(profileMenu.map((e) => e.command)).toEqual(['modbench.profile.switch']);
  });
});

describe('package.json New Plugin / record filter reachable from the merged tree', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const entryFor = (command: string) =>
    present(
      titleMenus().find((e) => e.command === command && requires(e.when, 'view == modbench.pluginListTree')),
      `a view/title entry for ${command} on modbench.pluginListTree`,
    );

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

  it.each(['modbench.record.filter', 'modbench.record.clearFilter', 'modbench.plugin.create'])('gates %s\'s palette entry to an instance', (command) => {
    const palette = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']");
    const entry = present(palette.find((e) => e.command === command), `a commandPalette entry for ${command}`);
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
});

describe('package.json contributes the conflict table\'s cell value as a setting (mods-conflicts.md, Cells)', () => {
  it('a choice of the values the table can show, the size by default', () => {
    expect(pkg.contributes.configuration.properties[CELL_VALUE_SETTING]).toMatchObject({
      type: 'string', enum: [...CONFLICT_CELL_VALUES], default: 'size',
    });
  });
});

describe('package.json contributes the port to attach to a running mEdit as a setting', () => {
  it('null by default, not the 0 VS Code gives a number setting with no default', () => {
    expect(pkg.contributes.configuration.properties['modbench.attachToBackendPort']).toMatchObject({
      type: ['number', 'null'], default: null,
    });
  });
});

describe('package.json contributes the port of the agent\'s MCP server as a setting (agent.md, Any agent, story 5)', () => {
  it('a number with a default, so every workspace has the same port unless it sets another', () => {
    expect(pkg.contributes.configuration.properties['modbench.agent.port']).toMatchObject({ type: 'number', default: 47200 });
  });
});

describe('package.json contributes the Mods view\'s indicators and grey as settings (mods.md, Indicators)', () => {
  const { properties } = pkg.contributes.configuration;

  it('the grey of a file the game does not get: a switch, on by default, under the key the grey reads', () => {
    expect(properties[GREY_INACTIVE_FILES_SETTING]).toMatchObject({ type: 'boolean', default: true });
  });

  it('a switch for each indicator\'s badge and colour, under the keys they read, defaulting as the table says', () => {
    const switches = Object.fromEntries([...MOD_INDICATORS, PUBLISHER_TAG_INDICATOR].flatMap(({ id }) => (['badge', 'colour'] as const)
      .map((part) => [`${id} ${part}`, properties[indicatorSetting(id, part)]?.type === 'boolean' && properties[indicatorSetting(id, part)]?.default]))) as unknown;

    expect(switches).toEqual({
      'overwritesLooseFiles badge': false, 'overwritesLooseFiles colour': false,
      'overwrittenLooseFiles badge': true, 'overwrittenLooseFiles colour': false,
      'redundant badge': true, 'redundant colour': false,
      'containsExcludedFiles badge': false, 'containsExcludedFiles colour': false,
      'updateAvailable badge': true, 'updateAvailable colour': false,
      'publisherTag badge': true, 'publisherTag colour': false,
    });
  });

  it('a theme colour for each indicator', () => {
    const contributed = pkg.contributes.colors.map((colour) => colour.id);
    expect([...MOD_INDICATORS, PUBLISHER_TAG_INDICATOR].filter(({ colour }) => !contributed.includes(colour)).map(({ id }) => id)).toEqual([]);
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

  it('offers every catalog gesture in the palette, but a gesture specified ahead of its code', () => {
    const gestureIds = catalogCommandIds(GESTURES_MARKDOWN);
    const declared = new Set(commands.map((c) => c.command));
    const hidden = [...gestureIds].filter((id) => gatedFalse().has(id) || (!declared.has(id) && !SPECIFIED_AHEAD_OF_CODE.includes(id)));
    expect(
      hidden,
      'commands.md, Entry points are not gestures: every gesture is also in the command palette.',
    ).toEqual([]);
  });

  it('registers no gesture still listed as specified ahead of its code, so the list expires with the code', () => {
    const declared = new Set(commands.map((c) => c.command));
    expect(SPECIFIED_AHEAD_OF_CODE.filter((id) => declared.has(id))).toEqual([]);
  });

  it('still registers every gesture named as retired ahead of its code, so the list expires with the code', () => {
    const declared = new Set(commands.map((c) => c.command));
    expect(RETIRED_AHEAD_OF_CODE.filter((id) => !declared.has(id))).toEqual([]);
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
    const systemCommandIds = catalogCommandIds(SYSTEM_COMMANDS_MARKDOWN);
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

  const REVEAL_ENTRY: [string, string] = ['modbench.plugin.reveal', '1_open'];
  const COPY_VALUE_ENTRY: [string, string] = ['modbench.copyValue', '5_copy'];
  const OPEN_ENTRY: [string, string] = [OPEN_PINNED, '1_open'];
  const REFERENCES_ENTRY: [string, string] = [REFERENCED_BY, '1_open'];
  const ENABLE_ENTRY: [string, string] = ['modbench.plugin.enable', '2_change'];
  const DISABLE_ENTRY: [string, string] = ['modbench.plugin.disable', '2_change'];
  const RENAME_ENTRY: [string, string] = ['modbench.plugin.rename', '2_change'];
  const CREATE_RECORD_ENTRY: [string, string] = ['modbench.record.create', '3_create'];
  const DECOMPILE_AND_COMMIT_ENTRY: [string, string] = ['modbench.mod.decompileAndCommit', '4_sourceControl'];
  const DECOMPILE_ENTRY: [string, string] = ['modbench.plugin.decompile', '4_sourceControl'];
  const BUILD_ENTRY: [string, string] = ['modbench.mod.build', '4_sourceControl'];
  const COPY_RECORD_ENTRY: [string, string] = ['modbench.record.copy', '5_copy'];
  const DELETE_RECORD_ENTRY: [string, string] = ['modbench.record.delete', '6_destroy'];
  const recordKinds = ['record', 'worldspace', 'cell', 'placed'];
  const containerKinds = ['record', 'worldspace', 'cell'];

  const menus: [contextValue: string, entries: [string, string][]][] = [
    ['plugin disabled inNonSourceMod nonCompiledPlugin', [REVEAL_ENTRY, ENABLE_ENTRY, DECOMPILE_AND_COMMIT_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin enabled inSourceMod compiledPlugin editable', [REVEAL_ENTRY, DISABLE_ENTRY, RENAME_ENTRY, CREATE_RECORD_ENTRY, DECOMPILE_ENTRY, BUILD_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin disabled inSourceMod compiledPlugin', [REVEAL_ENTRY, ENABLE_ENTRY, RENAME_ENTRY, DECOMPILE_ENTRY, BUILD_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin enabled inSourceMod compiledPlugin', [REVEAL_ENTRY, DISABLE_ENTRY, RENAME_ENTRY, DECOMPILE_ENTRY, BUILD_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin enabled inSourceMod nonCompiledPlugin', [REVEAL_ENTRY, DISABLE_ENTRY, DECOMPILE_ENTRY, BUILD_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin enabled inNonSourceMod', [REVEAL_ENTRY, DISABLE_ENTRY, DECOMPILE_AND_COMMIT_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin enabled inOverwrite nonCompiledPlugin', [REVEAL_ENTRY, DISABLE_ENTRY, COPY_VALUE_ENTRY]],
    ['plugin enabled nonCompiledPlugin', [REVEAL_ENTRY, DISABLE_ENTRY, COPY_VALUE_ENTRY]],
    ['pluginImplicit', [REVEAL_ENTRY, COPY_VALUE_ENTRY]],
    ['recordType editable creatable', [CREATE_RECORD_ENTRY]],
    ['recordType creatable', []],
    ['recordType editable', []],
    ...recordKinds.map((kind): [string, [string, string][]] => [`${kind} editable`, [OPEN_ENTRY, REFERENCES_ENTRY, COPY_RECORD_ENTRY, COPY_VALUE_ENTRY, DELETE_RECORD_ENTRY]]),
    ...containerKinds.map((kind): [string, [string, string][]] => [`${kind} editable container`, [OPEN_ENTRY, REFERENCES_ENTRY, CREATE_RECORD_ENTRY, COPY_RECORD_ENTRY, COPY_VALUE_ENTRY, DELETE_RECORD_ENTRY]]),
    ['record', [OPEN_ENTRY, REFERENCES_ENTRY, COPY_RECORD_ENTRY, COPY_VALUE_ENTRY]],
    ['record container', [OPEN_ENTRY, REFERENCES_ENTRY, COPY_RECORD_ENTRY, COPY_VALUE_ENTRY]],
    ...['block', 'subBlock', 'placedGroup-persistent', 'indexing', 'error'].map((kind): [string, [string, string][]] => [kind, []]),
  ];

  it.each(menus)('the menu on a %s row', (contextValue, entries) => {
    expect(menuOf(contextValue)).toEqual(entries);
  });

  it('plugin menu: enable and disable share one slot', () => {
    const slotOf = (command: string) =>
      present(inPluginsView('view/item/context').find((e) => e.command === command), command).group;
    expect(slotOf('modbench.plugin.enable')).toBe(slotOf('modbench.plugin.disable'));
  });

  const COPY = { key: 'ctrl+c', mac: 'cmd+c', command: 'modbench.copyValue' };

  it.each([
    [{}, []],
    [{ 'modbench.plugin.selectionToggle': 'enable' }, [{ key: 'space', command: 'modbench.plugin.enable' }]],
    [{ 'modbench.plugin.selectionToggle': 'disable' }, [{ key: 'space', command: 'modbench.plugin.disable' }]],
    [{ 'modbench.plugin.singleCompiledPlugin': true }, [{ key: 'f2', command: 'modbench.plugin.rename' }]],
    [{ 'modbench.plugin.allDeletableRecords': true }, [{ key: 'Delete', mac: 'cmd+backspace', command: 'modbench.record.delete' }]],
  ])('on the focused Plugins tree with %j, the keys that fire are those of the commands the selection allows, and copy value', (facts, keys) => {
    expectKeysFiring({ focusedView: 'modbench.pluginListTree', listFocus: true, ...inInstance, ...facts }, [...keys, COPY]);
  });
});

describe('package.json Downloads row menu order', () => {
  const DOWNLOADED_FILE_ROW = String.raw`viewItem =~ /\bdownloadedFile\b/`;
  const downloadedFileRowMenu = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => requires(e.when, 'view == modbench.downloads') && requires(e.when, DOWNLOADED_FILE_ROW));

  const [INSTALL, QUERY_INFO, VIEW_ON_NEXUS, OPEN, OPEN_META, EXCLUDE, INCLUDE, COPY_VALUE, DELETE] = [
    'modbench.mod.install', 'modbench.downloadedFile.queryInfo', 'modbench.mod.viewOnNexus', 'modbench.downloadedFile.open', 'modbench.downloadedFile.openMeta',
    'modbench.downloadedFile.exclude', 'modbench.downloadedFile.include', 'modbench.copyValue', 'modbench.downloadedFile.delete',
  ];

  it.each([
    ['downloadedFile', [INSTALL, OPEN, EXCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile hasModID', [INSTALL, VIEW_ON_NEXUS, OPEN, EXCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile hasMeta', [INSTALL, OPEN, OPEN_META, EXCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile excluded', [INSTALL, OPEN, INCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile hasModID hasMeta excluded', [INSTALL, VIEW_ON_NEXUS, OPEN, OPEN_META, INCLUDE, COPY_VALUE, DELETE]],
  ])('the menu on a %s row', (viewItem, commands) => {
    expect(offeredIn(downloadedFileRowMenu(), { view: 'modbench.downloads', viewItem })).toEqual(commands);
  });

  it.each([
    ['downloadedFile', [INSTALL, QUERY_INFO, OPEN, EXCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile hasModID', [INSTALL, QUERY_INFO, VIEW_ON_NEXUS, OPEN, EXCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile hasFileID', [INSTALL, QUERY_INFO, OPEN, EXCLUDE, COPY_VALUE, DELETE]],
    ['downloadedFile hasModID hasFileID', [INSTALL, VIEW_ON_NEXUS, OPEN, EXCLUDE, COPY_VALUE, DELETE]],
  ])('the menu on a %s row while logged in to Nexus offers query info only for a file whose metadata lacks an ID', (viewItem, commands) => {
    expect(offeredIn(downloadedFileRowMenu(), { view: 'modbench.downloads', viewItem, 'modbench.nexus.loggedIn': true })).toEqual(commands);
  });

  it('orders the row in strictly increasing slots: install, query info, view on Nexus, open, open metadata, exclude/include sharing one, copy value, delete', () => {
    const entries = downloadedFileRowMenu();
    const slotOf = (command: string): number => {
      const group = present(entries.find((e) => e.command === command), `a ${command} row-menu entry`).group ?? '';
      return Number(present(/@(\d+)$/.exec(group)?.[1], `a numbered group for ${command} (got "${group}")`));
    };
    const exclude = slotOf('modbench.downloadedFile.exclude');
    const include = slotOf('modbench.downloadedFile.include');
    expect(include).toBe(exclude);

    const slots = [
      'modbench.mod.install', 'modbench.downloadedFile.queryInfo', 'modbench.mod.viewOnNexus', 'modbench.downloadedFile.open',
      'modbench.downloadedFile.openMeta', 'modbench.downloadedFile.exclude', 'modbench.copyValue',
      'modbench.downloadedFile.delete',
    ].map(slotOf);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe('package.json view keys', () => {
  const VIEW_SCOPES = ['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads']
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
    'modbench.modList', 'modbench.pluginListTree', 'modbench.downloads',
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

describe('package.json decompile and commit\'s palette entry', () => {
  const MODS = { focusedView: 'modbench.modList', ...inInstance, 'modbench.mod.holdsNonSourceModWithPlugin': true, 'modbench.mod.sourceGestureRowsIn': 'modbench.modList' };
  const PLUGINS = { focusedView: 'modbench.pluginListTree', ...inInstance, 'modbench.plugin.allInNonSourceMod': true, 'modbench.mod.sourceGestureRowsIn': 'modbench.pluginListTree' };

  it('is in the palette while Mods or Plugins has focus, was last selected in, and holds what decompile and commit acts on', () => {
    expect(paletteOffers('modbench.mod.decompileAndCommit', MODS)).toBe(true);
    expect(paletteOffers('modbench.mod.decompileAndCommit', PLUGINS)).toBe(true);
  });

  it('is not in the palette when the last selection was made in the other view', () => {
    expect(paletteOffers('modbench.mod.decompileAndCommit', { ...MODS, 'modbench.mod.sourceGestureRowsIn': 'modbench.pluginListTree' })).toBe(false);
    expect(paletteOffers('modbench.mod.decompileAndCommit', { ...PLUGINS, 'modbench.mod.sourceGestureRowsIn': 'modbench.modList' })).toBe(false);
  });

  it('is not in the palette when the focused view holds nothing to decompile and commit', () => {
    expect(paletteOffers('modbench.mod.decompileAndCommit', without(MODS, 'modbench.mod.holdsNonSourceModWithPlugin'))).toBe(false);
    expect(paletteOffers('modbench.mod.decompileAndCommit', without(PLUGINS, 'modbench.plugin.allInNonSourceMod'))).toBe(false);
  });
});

describe('package.json conflict table menus follow mods-conflicts.md', () => {
  const inTable = (section: string): MenuEntry[] => present(pkg.contributes.menus['webview/context'], "contributes.menus['webview/context']")
    .filter((e) => holds(e.when, { webviewId: 'modbench.conflicts', webviewSection: section }));

  it.each([
    ['conflictColumn', 'modbench.mod.openConflicts'],
    ['conflictCell', 'modbench.mod.compareFile'],
  ])('%s: its one gesture, and nothing else', (section, command) => {
    expect(placed(inTable(section))).toEqual([[command, '1_open']]);
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
      ['modbench.record.referencedBy', '1_open'],
      ['modbench.record.addElement', '2_change'],
      ['modbench.record.removeElement', '2_change'],
      ['modbench.record.moveElementUp', '2_change'],
      ['modbench.record.moveElementDown', '2_change'],
      ['modbench.mod.decompileAndCommit', '4_sourceControl'],
      ['modbench.plugin.decompile', '4_sourceControl'],
      ['modbench.mod.build', '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
      ['modbench.record.copy', '5_copy'],
      ['modbench.record.delete', '6_destroy'],
    ]);
  });

  const DECOMPILE = 'modbench.plugin.decompile';
  const BUILD = 'modbench.mod.build';
  const RECORD_COPY = 'modbench.record.copy';

  it.each([
    ['a cell with everything to act on, go to record, open field value, add, remove, move and copy value in that order',
      { webviewSection: 'cell reference stringValue arrayParent arrayElement', copyText: 'x', canMoveUp: true, canMoveDown: true }, [
        'modbench.record.openReference', 'modbench.record.openFieldValue', 'modbench.record.addElement',
        'modbench.record.removeElement', 'modbench.record.moveElementUp', 'modbench.record.moveElementDown', 'modbench.copyValue',
      ]],
    ['a cell with something to copy', { webviewSection: 'cell', copyText: 'x' }, ['modbench.copyValue']],
    ['a cell with nothing to copy', { webviewSection: 'cell' }, []],
    ['the column of a plugin in a non-source mod', { webviewSection: 'recordHeader', inMod: 'nonSourceMod', editable: false },
      [REFERENCED_BY, 'modbench.mod.decompileAndCommit', RECORD_COPY]],
    ['the column of a plugin in a source mod that is not editable', { webviewSection: 'recordHeader', inMod: 'sourceMod', editable: false },
      [REFERENCED_BY, DECOMPILE, BUILD, RECORD_COPY]],
    ['the column of an editable plugin', { webviewSection: 'recordHeader', inMod: 'sourceMod', editable: true },
      [REFERENCED_BY, DECOMPILE, BUILD, RECORD_COPY, 'modbench.record.delete']],
    ['the column of a plugin of the game or Overwrite, in no mod', { webviewSection: 'recordHeader', inMod: 'none', editable: false },
      [REFERENCED_BY, RECORD_COPY]],
  ])('offers on %s only what applies', (_what, facts, commands) => {
    expect(offered(facts)).toEqual(commands);
  });

  it('hides the internal command that follows a reference from the palette', () => {
    const entries = present(pkg.contributes.menus.commandPalette, "contributes.menus['commandPalette']")
      .filter((e) => e.command === 'modbench.record.openReference');
    expect(entries.map((e) => e.when)).toEqual(['false']);
  });
});

describe('package.json build\'s palette entry', () => {
  it('is in the palette in an instance while any mod is a source mod', () => {
    expect(paletteOffers('modbench.mod.build', { ...inInstance, [ANY_SOURCE_MOD_KEY]: true })).toBe(true);
    expect(paletteOffers('modbench.mod.build', inInstance)).toBe(false);
    expect(paletteOffers('modbench.mod.build', { [ANY_SOURCE_MOD_KEY]: true })).toBe(false);
  });
});

describe('package.json git init, update manifest and restore from manifest follow modlist-repository.md, Menus and keys', () => {
  const hasRepository = { ...inInstance, [HAS_REPOSITORY_KEY]: true, [REPOSITORY_SET_UP_KEY]: true };
  const unsetUpRepository = { ...inInstance, [HAS_REPOSITORY_KEY]: true, [REPOSITORY_SET_UP_KEY]: false };
  const onRow = (view: string, viewItem: string, facts: Context): [string, string][] =>
    placed(present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => holds(e.when, { view, viewItem, ...facts }) && [UPDATE_MANIFEST, RESTORE_FROM_MANIFEST, GIT_INIT].includes(e.command)));

  it('offers update manifest, then restore from manifest, in the Source Control title bar\'s overflow, for the instance\'s own repository alone', () => {
    const entries = present(pkg.contributes.menus['scm/title'], "contributes.menus['scm/title']");

    expect(entries.map((e) => e.command)).toEqual([UPDATE_MANIFEST, RESTORE_FROM_MANIFEST]);
    expect(entries.every((e) => requires(e.when, 'scmProvider == git') && requires(e.when, 'scmProviderRootUri in modbench.modlist.instanceRoots'))).toBe(true);
    expect(entries.map((e) => e.group)).toEqual(['modbench@1', 'modbench@2']);
  });

  it('offers git init in Source Control\'s welcome inside an instance with no repository, saying it writes the ignore list', () => {
    const [first, ...others] = pkg.contributes.viewsWelcome.filter((w) => w.view === 'scm');
    const { when = '', contents } = present(first, 'the Source Control welcome');

    expect(others).toEqual([]);
    expect([holds(when, inInstance), holds(when, hasRepository), holds(when, {})]).toEqual([true, false, false]);
    expect(contents).toContain(`(command:${GIT_INIT})`);
    expect(contents).toContain('ignore list');
  });

  it.each([
    ['a mod', 'mod enabled', '4_sourceControl'],
    ['a separator', 'separator', '4_sourceControl'],
  ])('offers update manifest, then restore from manifest, on %s row while the instance holds a repository', (_row, viewItem, group) => {
    expect([onRow('modbench.modList', viewItem, hasRepository), onRow('modbench.modList', viewItem, inInstance)])
      .toEqual([[[UPDATE_MANIFEST, group], [RESTORE_FROM_MANIFEST, group]], []]);
  });

  it('offers git init on the Modlist row with no repository or one git init has not set up, and update manifest then restore from manifest with a repository', () => {
    expect([onRow('modbench.toolbox', 'modlist', inInstance), onRow('modbench.toolbox', 'modlist', unsetUpRepository), onRow('modbench.toolbox', 'modlist', hasRepository)]).toEqual([
      [[GIT_INIT, 'modbench']],
      [[GIT_INIT, 'modbench'], [UPDATE_MANIFEST, 'modbench'], [RESTORE_FROM_MANIFEST, 'modbench']],
      [[UPDATE_MANIFEST, 'modbench'], [RESTORE_FROM_MANIFEST, 'modbench']],
    ]);
  });

  it('offers each on every mod in the Mods title bar\'s overflow while the instance holds a repository', () => {
    const offered = (facts: Context) => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']")
      .filter((e) => holds(e.when, { view: 'modbench.modList', ...facts }) && EVERY_MOD_ENTRY_POINTS.includes(e.command)).map((e) => e.command);

    expect([offered(hasRepository), offered(inInstance)]).toEqual([EVERY_MOD_ENTRY_POINTS, []]);
  });

  it('offers git init in the palette until git init has set the repository up, and update manifest and restore from manifest once the instance holds one', () => {
    expect([
      paletteOffers(GIT_INIT, inInstance), paletteOffers(GIT_INIT, hasRepository), paletteOffers(GIT_INIT, unsetUpRepository),
      paletteOffers(UPDATE_MANIFEST, inInstance), paletteOffers(UPDATE_MANIFEST, hasRepository), paletteOffers(UPDATE_MANIFEST, { [HAS_REPOSITORY_KEY]: true }),
      paletteOffers(RESTORE_FROM_MANIFEST, inInstance), paletteOffers(RESTORE_FROM_MANIFEST, hasRepository),
    ]).toEqual([true, false, true, false, true, false, false, true]);
  });

  it('offers no item on a Source Control row', () => {
    expect(pkg.contributes.menus['scm/resourceState/context']).toBeUndefined();
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
    ['modbench.plugin.rename', { 'modbench.plugin.singleCompiledPlugin': true }],
    ['modbench.plugin.enable', { 'modbench.plugin.holdsDisabledPlugin': true }],
    ['modbench.plugin.disable', { 'modbench.plugin.holdsEnabledPlugin': true }],
    ['modbench.plugin.move', { 'modbench.plugin.holdsPluginLine': true }],
    ['modbench.plugin.decompile', { 'modbench.plugin.allInSourceMod': true }],
    ['modbench.plugin.decompileAndRepair', { 'modbench.plugin.allMalformedInAMod': true }],
    ['modbench.record.create', { 'modbench.plugin.singleCreatable': true }],
    ['modbench.record.delete', { 'modbench.plugin.allDeletableRecords': true, ...IN_PLUGINS }],
    ['modbench.record.copy', { 'modbench.plugin.allRecords': true, ...IN_PLUGINS }],
  ]);

  it.each(['modbench.record.delete', 'modbench.record.copy'])('%s is not in the palette on a record selection made in another view', (command) => {
    const facts = { 'modbench.plugin.allDeletableRecords': true, 'modbench.plugin.allRecords': true, 'modbench.record.selectionIn': 'modbench.modList' };
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

describe('package.json Mods title bar, menus, keys and palette follow mods.md', () => {
  const MODS_VIEW = 'view == modbench.modList';
  const inModsView = (menu: string): MenuEntry[] =>
    present(pkg.contributes.menus[menu], `contributes.menus['${menu}']`).filter((e) => requires(e.when, MODS_VIEW));
  const rowMenu = (row: string): MenuEntry[] => inModsView('view/item/context').filter((e) => requires(e.when, row));
  const MOD_ROW = String.raw`viewItem =~ /\bmod\b/`;

  it('title bar: filter or clear, then sort direction, as icons, with Collapse All left to VS Code; install, create empty mod, update manifest, then restore from manifest in the overflow', () => {
    expect(placed(inModsView('view/title'))).toEqual([
      ['modbench.modList.filterHere', 'navigation'],
      ['modbench.modList.clearFilterHere', 'navigation'],
      ['modbench.mod.sortWinningAtTop', 'navigation'],
      ['modbench.mod.sortLosingAtTop', 'navigation'],
      ['modbench.mod.install', '3_create'],
      ['modbench.mod.createEmpty', '3_create'],
      [CHECK_FOR_UPDATES_HERE, '3_update'],
      ...EVERY_MOD_ENTRY_POINTS.map((command): [string, string] => [command, '4_sourceControl']),
    ]);
  });

  it('mod menu: open, change, create, source control, copy, then destroy', () => {
    expect(placed(rowMenu(MOD_ROW))).toEqual([
      ['modbench.mod.openFolder', '1_open'],
      ['modbench.mod.openSource', '1_open'],
      ['modbench.mod.openConflicts', '1_open'],
      ['modbench.mod.viewOnNexus', '1_open'],
      ['modbench.mod.enable', '2_change'],
      ['modbench.mod.disable', '2_change'],
      ['modbench.mod.move', '2_change'],
      ['modbench.mod.rename', '2_change'],
      ['modbench.mod.addPublisherTag', '2_change'],
      ['modbench.mod.removePublisherTag', '2_change'],
      ['modbench.mod.checkForUpdates', '2_change'],
      ['modbench.separator.add', '3_create'],
      ['modbench.mod.createEmpty', '3_create'],
      ['modbench.mod.install', '3_create'],
      ['modbench.mod.decompileAndCommit', '4_sourceControl'],
      ['modbench.mod.build', '4_sourceControl'],
      [UPDATE_MANIFEST, '4_sourceControl'],
      [RESTORE_FROM_MANIFEST, '4_sourceControl'],
      ['modbench.copyValue', '5_copy'],
      ['modbench.mod.uninstall', '6_destroy'],
    ]);
  });

  it('mod menu: enable and disable share one slot', () => {
    const slot = (command: string) => present(rowMenu(MOD_ROW).find((e) => e.command === command), command).group;
    expect(slot('modbench.mod.enable')).toBe(slot('modbench.mod.disable'));
  });

  const menuOn = (viewItem: string): [string, string][] =>
    placed(inModsView('view/item/context').filter((e) => holds(e.when, { view: 'modbench.modList', viewItem })));

  const OPEN_FOLDER_ENTRY: [string, string] = ['modbench.mod.openFolder', '1_open'];
  const OPEN_SOURCE_ENTRY: [string, string] = ['modbench.mod.openSource', '1_open'];
  const OPEN_CONFLICTS_ENTRY: [string, string] = ['modbench.mod.openConflicts', '1_open'];
  const VIEW_ON_NEXUS_ENTRY: [string, string] = ['modbench.mod.viewOnNexus', '1_open'];
  const GO_TO_MOD_ENTRY: [string, string] = ['modbench.mod.goToMod', '1_open'];
  const COMPARE_FILE_ENTRY: [string, string] = ['modbench.mod.compareFile', '1_open'];
  const MOVE_ENTRY: [string, string] = ['modbench.mod.move', '2_change'];
  const RENAME_ENTRY: [string, string] = ['modbench.mod.rename', '2_change'];
  const ADD_SEPARATOR_ENTRY: [string, string] = ['modbench.separator.add', '3_create'];
  const CREATE_EMPTY_ENTRY: [string, string] = ['modbench.mod.createEmpty', '3_create'];
  const INSTALL_ENTRY: [string, string] = ['modbench.mod.install', '3_create'];
  const DECOMPILE_AND_COMMIT_ENTRY: [string, string] = ['modbench.mod.decompileAndCommit', '4_sourceControl'];
  const BUILD_ENTRY: [string, string] = ['modbench.mod.build', '4_sourceControl'];
  const COPY_VALUE_ENTRY: [string, string] = ['modbench.copyValue', '5_copy'];
  const UNINSTALL_ROW_ENTRY: [string, string] = ['modbench.mod.uninstall', '6_destroy'];
  const ENABLE_ENTRY: [string, string] = ['modbench.mod.enable', '2_change'];
  const DISABLE_ENTRY: [string, string] = ['modbench.mod.disable', '2_change'];
  const EXCLUDE_FILE_ENTRY: [string, string] = ['modbench.mod.excludeFile', '2_change'];
  const INCLUDE_FILE_ENTRY: [string, string] = ['modbench.mod.includeFile', '2_change'];
  const modCreation = [ADD_SEPARATOR_ENTRY, CREATE_EMPTY_ENTRY, INSTALL_ENTRY];

  const menus: [contextValue: string, entries: [string, string][]][] = [
    [contextOf(new ModNode({ kind: 'mod', name: 'X', enabled: true })), [OPEN_FOLDER_ENTRY, OPEN_CONFLICTS_ENTRY, DISABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    [contextOf(new ModNode({ kind: 'mod', name: 'X', enabled: false, nexusId: '1' })), [OPEN_FOLDER_ENTRY, OPEN_CONFLICTS_ENTRY, VIEW_ON_NEXUS_ENTRY, ENABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    ['mod enabled holdsPlugin nonSourceMod', [OPEN_FOLDER_ENTRY, OPEN_CONFLICTS_ENTRY, DISABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, DECOMPILE_AND_COMMIT_ENTRY, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    ['mod enabled holdsPlugin sourceMod', [OPEN_FOLDER_ENTRY, OPEN_SOURCE_ENTRY, OPEN_CONFLICTS_ENTRY, DISABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, BUILD_ENTRY, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    ['mod disabled sourceMod', [OPEN_FOLDER_ENTRY, OPEN_SOURCE_ENTRY, OPEN_CONFLICTS_ENTRY, ENABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, BUILD_ENTRY, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    ['mod enabled holdsPlugin', [OPEN_FOLDER_ENTRY, OPEN_CONFLICTS_ENTRY, DISABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    ['mod enabled nonSourceMod', [OPEN_FOLDER_ENTRY, OPEN_CONFLICTS_ENTRY, DISABLE_ENTRY, MOVE_ENTRY, RENAME_ENTRY, ...modCreation, COPY_VALUE_ENTRY, UNINSTALL_ROW_ENTRY]],
    [contextOf(new SeparatorNode({ kind: 'separator', name: 'S', enabled: true }, [])), [MOVE_ENTRY, ADD_SEPARATOR_ENTRY, ['modbench.separator.rename', '3_create'], COPY_VALUE_ENTRY, ['modbench.separator.delete', '6_destroy']]],
    [contextOf(new OverwriteNode([], 'MO2')), [OPEN_FOLDER_ENTRY]],
    ['file', [OPEN_FOLDER_ENTRY, COPY_VALUE_ENTRY]],
    ['file conflict', [OPEN_FOLDER_ENTRY, GO_TO_MOD_ENTRY, COPY_VALUE_ENTRY]],
    ['file conflict losing', [OPEN_FOLDER_ENTRY, COMPARE_FILE_ENTRY, GO_TO_MOD_ENTRY, COPY_VALUE_ENTRY]],
    ['file included', [OPEN_FOLDER_ENTRY, EXCLUDE_FILE_ENTRY, COPY_VALUE_ENTRY]],
    ['file excluded', [OPEN_FOLDER_ENTRY, INCLUDE_FILE_ENTRY, COPY_VALUE_ENTRY]],
    ['file conflict included', [OPEN_FOLDER_ENTRY, GO_TO_MOD_ENTRY, EXCLUDE_FILE_ENTRY, COPY_VALUE_ENTRY]],
    ['file conflict excluded', [OPEN_FOLDER_ENTRY, GO_TO_MOD_ENTRY, INCLUDE_FILE_ENTRY, COPY_VALUE_ENTRY]],
    ['folder', [OPEN_FOLDER_ENTRY, COPY_VALUE_ENTRY]],
  ];

  const CHECK_FOR_UPDATES = 'modbench.mod.checkForUpdates';
  it.each([
    ['a mod with a Nexus mod ID', 'mod enabled hasNexus', true, true],
    ['a mod with a Nexus mod ID', 'mod enabled hasNexus', false, false],
    ['a mod with no Nexus mod ID', 'mod enabled', true, false],
    ['a separator', 'separator', true, true],
    ['a separator', 'separator', false, false],
  ])('check for updates on %s (%s), logged in %s: offered %s', (_name, viewItem, loggedIn, offered) => {
    const entry = inModsView('view/item/context').find((e) => e.command === CHECK_FOR_UPDATES && holds(e.when, { view: 'modbench.modList', viewItem, [LOGGED_IN_KEY]: loggedIn }));

    expect(entry !== undefined).toBe(offered);
  });

  it.each(menus)('the menu on a %s row', (contextValue, entries) => {
    expect(menuOn(contextValue)).toEqual(entries);
  });

  const ADD_PUBLISHER_TAG = 'modbench.mod.addPublisherTag';
  const REMOVE_PUBLISHER_TAG = 'modbench.mod.removePublisherTag';
  const publisherTagItems = (viewItem: string, facts: Context): string[] =>
    inModsView('view/item/context').filter((e) => holds(e.when, { view: 'modbench.modList', viewItem, ...facts }))
      .filter((e) => [ADD_PUBLISHER_TAG, REMOVE_PUBLISHER_TAG].includes(e.command)).map((e) => `${e.command} ${e.group}`);

  it.each([
    ['mod enabled', {}, []],
    ['mod enabled', { 'modbench.mod.hasPublisher': true }, [`${ADD_PUBLISHER_TAG} 2_change@4`]],
    ['mod enabled holdsPublisherTag', { 'modbench.mod.hasPublisher': true }, [`${ADD_PUBLISHER_TAG} 2_change@4`, `${REMOVE_PUBLISHER_TAG} 2_change@5`]],
    ['mod enabled', { 'modbench.mod.hasPublisher': true, 'modbench.mod.holdsPublisherTag': true }, [`${ADD_PUBLISHER_TAG} 2_change@4`]],
    ['file included', { 'modbench.mod.hasPublisher': true }, []],
    ['file included', { 'modbench.mod.hasPathPublisher': true }, [`${ADD_PUBLISHER_TAG} 2_change@2`]],
    ['file included holdsPublisherTag', { 'modbench.mod.hasPathPublisher': true }, [`${ADD_PUBLISHER_TAG} 2_change@2`, `${REMOVE_PUBLISHER_TAG} 2_change@3`]],
    ['folder holdsPublisherTag', {}, [`${REMOVE_PUBLISHER_TAG} 2_change@3`]],
    ['folder', { 'modbench.mod.hasPathPublisher': true, 'modbench.mod.holdsPublisherTag': true }, [`${ADD_PUBLISHER_TAG} 2_change@2`]],
    ['file included inOverwrite holdsPublisherTag', { 'modbench.mod.hasPathPublisher': true }, []],
    ['folder inOverwrite holdsPublisherTag', { 'modbench.mod.hasPathPublisher': true }, []],
    ['separator', { 'modbench.mod.hasPublisher': true, 'modbench.mod.holdsPublisherTag': true }, []],
  ])('on a %s row with %j, the publisher tag items are %j', (viewItem, facts, items) => {
    expect(publisherTagItems(viewItem, facts)).toEqual(items);
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
    ['modbench.mod.openSource', { 'modbench.mod.singleOpenSourceRow': true }],
    ['modbench.mod.goToMod', { 'modbench.mod.singleGoToModRow': true }],
    ['modbench.mod.openConflicts', ONE_MOD],
    ['modbench.mod.compareFile', { 'modbench.mod.singleCompareFileRow': true }],
    ['modbench.mod.excludeFile', { 'modbench.mod.holdsIncludedFile': true }],
    ['modbench.mod.includeFile', { 'modbench.mod.holdsExcludedFile': true }],
    ['modbench.mod.addPublisherTag', { 'modbench.mod.hasPublisher': true, 'modbench.mod.holdsTaggableRow': true }],
    ['modbench.mod.removePublisherTag', { 'modbench.mod.holdsPublisherTag': true }],
  ]);

  it.each([
    ['modbench.separator.delete', 'mod'],
    ['modbench.mod.uninstall', 'separator'],
    ['modbench.mod.rename', 'separator'],
    ['modbench.mod.openConflicts', 'separator'],
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

  it('the empty list\'s message names the overflow\'s titles of install and create empty mod', () => {
    const overflowTitles = inModsView('view/title').filter((e) => groupOf(e) === '3_create')
      .map((e) => present(pkg.contributes.commands.find((c) => c.command === e.command), e.command).title);
    expect(overflowTitles.length).toBeGreaterThan(0);
    const instance = new FakeInstance(instanceValueFixture({ mods: [] }));
    const shown = present(new ModListProvider({ statuses: NO_MOD_STATUSES, instance, open: new OpenRows(instance) }).viewMessage(), 'the empty list\'s message');
    expect(overflowTitles.filter((title) => !shown.includes(title))).toEqual([]);
    expect(shown).toContain('overflow');
  });
});

describe('package.json open', () => {
  it('reads Open', () => {
    expect(pkg.contributes.commands.find((c) => c.command === OPEN_PINNED)?.title).toBe('Open');
  });
});

const catalog = catalogCommandIds(COMMANDS_MARKDOWN);

const OPEN_REFERENCE = 'modbench.record.openReference';
const FILTER_ENTRY_POINTS = ['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads']
  .flatMap((view) => [`${view}.filterHere`, `${view}.clearFilterHere`]);
const GRID_KEY_ENTRY_POINTS = ['editHere', 'cutHere', 'pasteHere', 'clearHere'].map((verb) => `modbench.recordGrid.${verb}`);
const ENTRY_POINTS = [...FILTER_ENTRY_POINTS, ...GRID_KEY_ENTRY_POINTS, OPEN_PINNED, OPEN_REFERENCE, ...EVERY_MOD_ENTRY_POINTS, CHECK_FOR_UPDATES_HERE, OPEN_DEPLOYMENT_FOLDER_SETTING];

describe('package.json registers every command under its catalog Command ID', () => {
  const registered = pkg.contributes.commands.map((c) => c.command);

  it('reads the Command ID column of every catalog table', () => {
    expect(catalog).toContain('modbench.mod.enable');
    expect(catalog).toContain('modbench.downloadedFile.hideExcluded');
    expect(catalog).toContain('modbench.plugin.sync');
  });

  it('registers no ID that is not in the catalog', () => {
    const offenders = registered.filter((id) => !catalog.has(id) && !ENTRY_POINTS.includes(id) && !RETIRED_AHEAD_OF_CODE.includes(id));
    expect(
      offenders,
      offenders.map((id) => `${id} is not a Command ID in spec/surfaces/commands.md. The catalog is the `
        + 'source: register the gesture under the ID its row gives it.').join('\n'),
    ).toEqual([]);
  });
});

describe('package.json Delete keys', () => {
  it('each passes its own view as args, since a key cannot name the rows it deletes', () => {
    const deleteKeys = pkg.contributes.keybindings.filter((k) => k.command === 'modbench.record.delete');
    expect(deleteKeys.map((k) => [k.key, k.args])).toEqual([
      ['Delete', { view: 'modbench.pluginListTree' }],
    ]);
  });
});

describe('package.json Referenced By menus', () => {
  const inItsList = { 'reference-list.source': 'modbench.referencedBy' };
  const menuOf = (viewItem: string, facts: Context = inItsList) =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']")
      .filter((e) => holds(e.when, { view: 'references-view.tree', viewItem, ...facts }))
      .map((e) => [e.command, e.group]);

  it('offers a referrer open, referenced by, then copy value', () => {
    expect(menuOf('referencedByReferrer')).toEqual([
      [OPEN_PINNED, '1_open@1'], [REFERENCED_BY, '1_open@2'], ['modbench.copyValue', '5_copy@1'],
    ]);
  });

  it.each([
    ['an editable container', 'referencedByHolder editable container', [
      [OPEN_PINNED, '1_open@1'], [REFERENCED_BY, '1_open@2'], ['modbench.record.create', '3_create@1'],
      ['modbench.record.copy', '5_copy@1'], ['modbench.copyValue', '5_copy@2'], ['modbench.record.delete', '6_destroy@1'],
    ]],
    ['an editable record', 'referencedByHolder editable', [
      [OPEN_PINNED, '1_open@1'], [REFERENCED_BY, '1_open@2'],
      ['modbench.record.copy', '5_copy@1'], ['modbench.copyValue', '5_copy@2'], ['modbench.record.delete', '6_destroy@1'],
    ]],
    ['a record that is not editable', 'referencedByHolder', [
      [OPEN_PINNED, '1_open@1'], [REFERENCED_BY, '1_open@2'], ['modbench.record.copy', '5_copy@1'], ['modbench.copyValue', '5_copy@2'],
    ]],
  ])('offers a plugin copy that is %s what a Plugins record row offers', (_, viewItem, expected) => {
    expect(menuOf(viewItem)).toEqual(expected);
  });

  it.each(['referencedByReferrer', 'referencedByHolder editable container'])('offers a %s row nothing in a list another extension filled', (viewItem) => {
    expect(menuOf(viewItem, { 'reference-list.source': 'typescript' })).toEqual([]);
  });

  it('binds no key in the References view, whose selection a key cannot read', () => {
    expect(pkg.contributes.keybindings.filter((k) => k.when.includes('references-view'))).toEqual([]);
  });
});

describe('package.json contributes the strings language as a setting (editor-fields.md, By type)', () => {
  it('a string defaulting to English', () => {
    expect(pkg.contributes.configuration.properties['modbench.stringsLanguage']).toMatchObject({ type: 'string', default: 'English' });
  });
});
