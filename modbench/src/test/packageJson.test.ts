import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { present } from '../ports/present';

// This file's one parse point for package.json: checks the fields every read below assumes and
// throws rather than handing back an unproven shape.
interface ViewsWelcomeEntry { view: string; when?: string; }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  return isRecord(v) && isString(v.view) && isOptionalString(v.when);
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
    throw new Error('Expected contributes.viewsWelcome to be an array of { view, when? }.');
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

describe('package.json viewsWelcome', () => {
  it('gates the "not an MO2 instance" message on a workspace actually being open, so no-workspace stays a neutral no-op (AC4)', () => {
    const welcome = present(
      pkg.contributes.viewsWelcome.find((w) => w.view === 'modbench.modList'),
      'a viewsWelcome entry for modbench.modList',
    );
    // workspaceIsMo2Instance is never set with no folder open, so without this guard the
    // wrong-folder message shows on a bare window. workspaceFolderCount is VS Code's own key.
    expect(present(welcome.when, "the entry's when clause")).toContain('workspaceFolderCount != 0');
  });

  // Unset context keys read falsy under `!key`, so `!modbench.workspaceIsMo2Instance` alone cannot
  // tell "not yet checked" from "checked, not an instance"; workspaceMo2CheckDone is set only once
  // the check has run. Exact-match, not .toContain, so a negated term cannot pass.
  it('cannot render before the MO2 check has actually run', () => {
    const welcome = present(
      pkg.contributes.viewsWelcome.find((w) => w.view === 'modbench.modList'),
      'a viewsWelcome entry for modbench.modList',
    );
    expect(present(welcome.when, "the entry's when clause")).toBe(
      'workspaceFolderCount != 0 && modbench.workspaceMo2CheckDone && !modbench.workspaceIsMo2Instance',
    );
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

  it('is never a right-click entry point — modbench.showReferencedBy appears in no menu contribution', () => {
    const menus: Record<string, { command: string }[]> = pkg.contributes.menus;
    for (const [menuId, entries] of Object.entries(menus)) {
      expect(
        entries.some((e) => e.command === 'modbench.showReferencedBy'),
        `expected no "${menuId}" entry invoking modbench.showReferencedBy`,
      ).toBe(false);
    }
  });
});

describe('package.json Toolbox view', () => {
  const sidebarViews = (): ViewEntry[] => present(pkg.contributes.views.modbench, "contributes.views['modbench']");

  it('is the first view in the Modbench container, so workspace-scope actions sit above the domain trees', () => {
    expect(present(sidebarViews()[0], 'the first view of the Modbench container').id).toBe('modbench.toolbox');
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

describe('package.json the Toolbox stack stays visible through an editing backend', () => {
  const welcome = (): ViewsWelcomeEntry[] => pkg.contributes.viewsWelcome;

  it('drops the now-redundant view-mode clause from the "not an MO2 instance" welcome message', () => {
    const entry = present(
      welcome().find((w) => w.view === 'modbench.modList' && (w.when ?? '').includes('workspaceIsMo2Instance')),
      'the not-an-MO2-instance welcome entry',
    );
    expect(present(entry.when, "the entry's when clause")).not.toMatch(/modbench\.viewMode/);
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

  // Rule 5 — docs/specs/containers.md.
  it('keeps modbench.pluginListTree.filter at slot 1 (unchanged by this slice)', () => {
    expect(entryFor('modbench.pluginListTree.filter').group).toBe('navigation@1');
  });

  it('places the record filter (setFilter/clearFilter) at slot 2', () => {
    expect(entryFor('modbench.setFilter').group).toBe('navigation@2');
    const clear = present(
      titleMenus().find((e) => e.command === 'modbench.clearFilter' && e.when.includes('modbench.pluginListTree')),
      'a view/title entry for modbench.clearFilter on modbench.pluginListTree',
    );
    expect(clear.group).toBe('navigation@2');
    expect(clear.when).toBe('view == modbench.pluginListTree && modbench.filterActive');
  });

  it('places New Plugin… at slot 3', () => {
    expect(entryFor('modbench.newPlugin').group).toBe('navigation@3');
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

  // Rule 6 — docs/specs/containers.md.
  const FILTERED_VIEWS = [
    ['modbench.modList', 'modbench.modList.filter'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filter'],
    ['modbench.downloads', 'modbench.downloads.filter'],
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
    ['modbench.modList', 'modbench.modList.filter', 'modbench.modList.clearFilter', 'modbench.modList.filterActive'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filter', 'modbench.pluginListTree.clearFilter', 'modbench.pluginListTree.filterActive'],
    ['modbench.downloads', 'modbench.downloads.filter', 'modbench.downloads.clearFilter', 'modbench.downloads.filterActive'],
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
    expect(openEntry.when).toBe(`view == ${view} && !${key}`);
    expect(clearEntry.when).toBe(`view == ${view} && ${key}`);
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
    expect(entry.when).toBe(`focusedView == ${view}`);
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
    expect(refreshCommands.map((c) => c.command)).toEqual(['modbench.refresh']);
  });

  it('puts it at slot 1 of the Toolbox and nowhere else', () => {
    const entries = titleMenus().filter((e) => e.command === 'modbench.refresh');
    expect(entries).toHaveLength(1);
    const entry = present(entries[0], 'the sole modbench.refresh view/title entry');
    expect(entry.when).toBe('view == modbench.toolbox');
    expect(entry.group).toBe('navigation@1');
  });

});

describe('package.json title-bar rubric', () => {
  const titleMenus = (): MenuEntry[] => present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
  const viewsOf = (entries: MenuEntry[]) =>
    new Set(entries.map((e) => /view == ([\w.]+)/.exec(e.when)?.[1]).filter((v): v is string => v !== undefined));

  // Rule 1 — docs/specs/containers.md.
  const WORKSPACE_ACTIONS = ['modbench.toolbox.switchProfile'];

  it.each(WORKSPACE_ACTIONS)('%s is absent from every domain tree title bar', (command) => {
    const views = viewsOf(titleMenus().filter((e) => e.command === command));
    expect([...views].filter((v) => v !== 'modbench.toolbox')).toEqual([]);
  });

  // Rule 2 — docs/specs/containers.md.
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

  // Rule 7 — docs/specs/containers.md.
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
    'modbench.array.add',
    'modbench.array.remove',
    'modbench.array.moveUp',
    'modbench.array.moveDown',
    // ADR-0018: each needs the clicked cell's or VMAD row's own identity from its
    // data-vscode-context — no ambient fallback, same posture as the array ops above.
    'modbench.field.openExtended',
    'modbench.downloads.install',
    'modbench.downloads.visitNexus',
    'modbench.downloads.openFile',
    'modbench.downloads.openMeta',
    'modbench.downloads.delete',
    'modbench.downloads.hide',
    'modbench.downloads.unhide',
    'modbench.modList.mod.openInExplorer',
    'modbench.modList.mod.addSeparatorBelow',
    'modbench.modList.mod.moveToSeparator',
    'modbench.modList.mod.uninstall',
    'modbench.modList.mod.viewOnNexus',
    'modbench.modList.separator.rename',
    'modbench.modList.separator.addSeparatorBelow',
    'modbench.modList.separator.delete',
    'modbench.modList.overwrite.reveal',
    'modbench.pluginListTree.revealInExplorer',
    // Needs the clicked row's plugin name to resolve which mod folder to track.
    'modbench.pluginListTree.track',
    // Needs the clicked row's plugin name — compiling "at main" from the palette with no
    // plugin in hand isn't a gesture worth a QuickPick-over-QuickPick (unlike modbench.saveAndCompile
    // itself, which falls back to one and stays palette-visible).
    'modbench.pluginListTree.compileAtMain',
    // Needs the clicked row's plugin name to resolve which mod folder (origin) to rebase —
    // same posture as Track/compileAtMain, no ambient fallback worth a QuickPick.
    'modbench.pluginListTree.rebase',
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
    expect(PALETTE_GATED).toHaveLength(31);
    const gatedFalse = new Set(palette.filter((e) => e.when === 'false').map((e) => e.command));
    const missingGate = PALETTE_GATED.filter((c) => !gatedFalse.has(c));
    const unexpectedGate = [...gatedFalse].filter((c) => !(PALETTE_GATED as readonly string[]).includes(c));
    expect(missingGate).toEqual([]);
    expect(unexpectedGate).toEqual([]);
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
      ['modbench.pluginListTree.revealInExplorer', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.pluginListTree.track', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.saveAndCompile', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.pluginListTree.compileAtMain', 'view == modbench.pluginListTree && viewItem == plugin'],
      ['modbench.pluginListTree.rebase', 'view == modbench.pluginListTree && viewItem == plugin'],
    ]);
  });
});

// ADR-0007: the Track gesture's own menu contribution.
describe('package.json per-plugin Track', () => {
  const contextMenus = (): MenuEntry[] =>
    present(pkg.contributes.menus['view/item/context'], "contributes.menus['view/item/context']");

  it('sits below the other row actions in the same row-action group', () => {
    const entry = present(
      contextMenus().find((e) => e.command === 'modbench.pluginListTree.track'),
      'the modbench.pluginListTree.track context-menu entry',
    );
    expect(entry.group).toBe('pluginActions@2');
  });

  // No icon: Track is a one-time, deliberately weighty gesture (ADR-0007: "deliberate friction"),
  // not a quick inline action.
  it('never appears as an inline or navigation icon', () => {
    const inline = contextMenus().filter((e) => e.command === 'modbench.pluginListTree.track' && e.group === 'inline');
    const trackTitleMenus = present(pkg.contributes.menus['view/title'], "contributes.menus['view/title']");
    const title = trackTitleMenus.filter((e) => e.command === 'modbench.pluginListTree.track');
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
