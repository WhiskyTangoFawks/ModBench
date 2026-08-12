import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

describe('package.json activation', () => {
  it('auto-activates on startup so the Activity Bar icon is never stuck hidden', () => {
    expect(pkg.activationEvents).toContain('onStartupFinished');
  });
});

describe('package.json viewsWelcome (#192)', () => {
  it('gates the "not an MO2 instance" message on a workspace actually being open, so no-workspace stays a neutral no-op (AC4)', () => {
    const welcome = (pkg.contributes.viewsWelcome as { view: string; when: string }[])
      .find((w) => w.view === 'modbench.modList');
    expect(welcome, 'expected a viewsWelcome entry for modbench.modList').toBeTruthy();
    // modbench.viewMode flips to 'loadout' before a workspace is even checked
    // (activate()), and workspaceIsMo2Instance is never set when no folder is
    // open — so without this guard, !workspaceIsMo2Instance reads true on a
    // bare VS Code window and the wrong-folder message would show with no
    // workspace open at all. workspaceFolderCount is VS Code's own built-in key.
    expect(welcome!.when).toContain('workspaceFolderCount != 0');
  });
});

describe('package.json Referenced By panel migration (#282)', () => {
  it('lives in a Panel-location viewsContainer, not stacked under the modbench activity-bar container', () => {
    const panelContainerIds = new Set(
      (pkg.contributes.viewsContainers.panel as { id: string }[]).map((c) => c.id),
    );
    const views = pkg.contributes.views as Record<string, { id: string }[]>;
    const referencedByContainer = Object.entries(views)
      .find(([, entries]) => entries.some((v) => v.id === 'modbench.referencedByTree'))?.[0];

    expect(referencedByContainer, 'expected a views entry for modbench.referencedByTree').toBeTruthy();
    expect(panelContainerIds.has(referencedByContainer!)).toBe(true);

    const sidebarViews = pkg.contributes.views.modbench as { id: string }[];
    expect(sidebarViews.some((v) => v.id === 'modbench.referencedByTree')).toBe(false);
  });

  it('is never a right-click entry point — modbench.showReferencedBy no longer appears in any menu contribution', () => {
    const menus = pkg.contributes.menus as Record<string, { command: string }[]>;
    for (const [menuId, entries] of Object.entries(menus)) {
      expect(
        entries.some((e) => e.command === 'modbench.showReferencedBy'),
        `expected no "${menuId}" entry invoking modbench.showReferencedBy`,
      ).toBe(false);
    }
  });
});

describe('package.json Loadout header view (#247)', () => {
  const sidebarViews = () => pkg.contributes.views.modbench as { id: string; name: string; when?: string }[];

  it('is the first view in the Modbench container, so workspace-scope actions sit above the domain trees', () => {
    expect(sidebarViews()[0].id).toBe('modbench.loadoutHeader');
  });

  it('carries no view-mode gate, so it survives #273 retiring modbench.viewMode', () => {
    const header = sidebarViews().find((v) => v.id === 'modbench.loadoutHeader');
    expect(header!.when).toBeUndefined();
  });
});

describe('package.json Pending Changes gates on staged work, not view mode (#273 Slice A)', () => {
  const sidebarViews = () => pkg.contributes.views.modbench as { id: string; name: string; when?: string }[];

  it('is visible exactly when modbench.hasPendingChanges is true, never on modbench.viewMode', () => {
    const view = sidebarViews().find((v) => v.id === 'modbench.changeGroupTree');
    expect(view!.when).toBe('modbench.hasPendingChanges');
  });
});

// VS Code has no view nesting/grouping within a container, so a "Plugins - " title prefix is the
// only available way to say Pending Changes and Referenced By are sub-functionality of the one
// Plugins tree, not siblings of equal standing (ADR-0035).
describe('package.json "Plugins - …" naming for Pending Changes and Referenced By (#273 Slice B)', () => {
  it('names the Pending Changes view "Plugins - Pending Changes"', () => {
    const sidebarViews = pkg.contributes.views.modbench as { id: string; name: string }[];
    const view = sidebarViews.find((v) => v.id === 'modbench.changeGroupTree');
    expect(view!.name).toBe('Plugins - Pending Changes');
  });

  it('names the Referenced By view "Plugins - Referenced By"', () => {
    const referencedByViews = pkg.contributes.views.modbenchReferencedBy as { id: string; name: string }[];
    const view = referencedByViews.find((v) => v.id === 'modbench.referencedByTree');
    expect(view!.name).toBe('Plugins - Referenced By');
  });
});

describe('package.json Loadout views stay visible through an editing session (#268)', () => {
  const sidebarViews = () => pkg.contributes.views.modbench as { id: string; name: string; when?: string }[];
  const welcome = () => pkg.contributes.viewsWelcome as { view: string; when: string }[];

  // ADR-0035's "valid first step": Launch mEdit must no longer hide the loadout it's editing
  // against. The Mods tree, the Plugin load order and Downloads carry no view-mode gate at
  // all now — #273, not this ticket, retires modbench.viewMode itself.
  it.each(['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads'])(
    '%s carries no view-mode gate, so it survives entering editing mode', (id) => {
      const view = sidebarViews().find((v) => v.id === id);
      expect(view!.when ?? '').not.toMatch(/modbench\.viewMode/);
    });

  // The editing Plugins tree stays gated — it browses a session that doesn't exist until
  // Launch mEdit creates one, so "appear in addition to, not instead of" still means gated on
  // 'editing', just no longer exclusive with the loadout trio above.
  // #273 Slice A: modbench.changeGroupTree no longer belongs in this list — it moved off the
  // view-mode gate onto modbench.hasPendingChanges (see the dedicated Slice A describe block).
  it.each(['modbench.pluginTree'])(
    '%s keeps its editing-mode gate — it has nothing to show before a session exists', (id) => {
      const view = sidebarViews().find((v) => v.id === id);
      expect(view!.when).toBe("modbench.viewMode == 'editing'");
    });

  it('drops the now-redundant view-mode clause from the "not an MO2 instance" welcome message', () => {
    const entry = welcome().find((w) => w.view === 'modbench.modList' && w.when.includes('workspaceIsMo2Instance'));
    expect(entry, 'expected the not-an-MO2-instance welcome entry').toBeTruthy();
    expect(entry!.when).not.toMatch(/modbench\.viewMode/);
  });
});

describe('package.json filtering is one UX (#247)', () => {
  const titleMenus = () => pkg.contributes.menus['view/title'] as { command: string; when: string; group: string }[];
  const commandTitle = (id: string) =>
    (pkg.contributes.commands as { command: string; title: string; icon?: string }[]).find((c) => c.command === id);

  // Every list view narrows by name the same way, through the same widget. Downloads was the
  // odd one out (#233 sent it to VS Code's native tree Find), which made the filter three
  // different answers across five title bars; one widget also gives #255 a single fix site.
  const FILTERED_VIEWS = [
    ['modbench.modList', 'modbench.modList.filter'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filter'],
    ['modbench.pluginTree', 'modbench.filterPluginTree'],
    ['modbench.downloads', 'modbench.downloads.filter'],
  ] as const;

  it.each(FILTERED_VIEWS)('%s narrows by name from slot 1', (view, command) => {
    const entry = titleMenus().find((e) => e.command === command && e.when.includes(view));
    expect(entry, `expected ${command} on ${view}`).toBeTruthy();
    expect(entry!.group).toBe('navigation@1');
  });

  it.each(FILTERED_VIEWS)('%s uses $(search) — narrowing by name, not by condition', (_view, command) => {
    expect(commandTitle(command)!.icon).toBe('$(search)');
  });

  // The record filter is a different affordance and keeps the funnel: it narrows by a SQL
  // condition, not by name. Same title bar, deliberately different icon.
  it('keeps $(filter) for the record filter, so the two never read as the same action', () => {
    expect(commandTitle('modbench.setFilter')!.icon).toBe('$(filter)');
  });
});

describe('package.json Refresh is one command (#247)', () => {
  const titleMenus = () => pkg.contributes.menus['view/title'] as { command: string; when: string; group: string }[];

  // Three views each grew their own Refresh under their own ticket — same need, three ids.
  // Refresh is workspace-scope (re-read what is on disk), so it belongs to the header, once.
  it('declares exactly one refresh command', () => {
    const refreshCommands = (pkg.contributes.commands as { command: string; icon?: string }[])
      .filter((c) => c.icon === '$(refresh)');
    expect(refreshCommands.map((c) => c.command)).toEqual(['modbench.refresh']);
  });

  it('puts it at slot 1 of the header and nowhere else', () => {
    const entries = titleMenus().filter((e) => e.command === 'modbench.refresh');
    expect(entries).toHaveLength(1);
    expect(entries[0].when).toBe('view == modbench.loadoutHeader');
    expect(entries[0].group).toBe('navigation@1');
  });

  it('leaves Reload Session distinct and in overflow — it costs seconds and can disturb staged work', () => {
    const entry = titleMenus().find((e) => e.command === 'modbench.reloadSession');
    expect(entry, 'expected Reload Session on the header').toBeTruthy();
    expect(entry!.group.startsWith('navigation')).toBe(false);
  });
});

describe('package.json title-bar rubric (#247)', () => {
  type MenuEntry = { command: string; when: string; group: string };
  const titleMenus = () => pkg.contributes.menus['view/title'] as MenuEntry[];
  const viewsOf = (entries: MenuEntry[]) =>
    new Set(entries.map((e) => /view == ([\w.]+)/.exec(e.when)?.[1]).filter(Boolean) as string[]);

  // Rule 1, scope first: an action that isn't about this tree's own domain doesn't go on this
  // tree. These six are workspace-scope — they swap the modlist, change the mode, or act on the
  // whole deployment — and each landed on whichever view happened to exist when it shipped.
  const WORKSPACE_ACTIONS = [
    'modbench.modList.switchProfile',
    'modbench.modList.launchMedit',
    'modbench.closeMedit',
    'modbench.modList.deploy',
    'modbench.modList.purge',
    'modbench.reloadSession',
  ];

  it.each(WORKSPACE_ACTIONS)('%s is absent from every domain tree title bar', (command) => {
    const views = viewsOf(titleMenus().filter((e) => e.command === command));
    expect([...views].filter((v) => v !== 'modbench.loadoutHeader')).toEqual([]);
  });

  // Rule 4: destructive actions never get an icon. Deploy and Purge rewrite the game
  // directory; they sit in the header's overflow, not its navigation group.
  it.each(['modbench.modList.deploy', 'modbench.modList.purge'])('%s stays in overflow, never a navigation icon', (command) => {
    const entries = titleMenus().filter((e) => e.command === command);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => !e.group.startsWith('navigation'))).toBe(true);
  });

  // Rule 2, four navigation icons maximum. Not taste: VS Code collapses navigation icons into
  // the `…` when a view is narrow, so a fifth is already unreliable. A two-command context-key
  // toggle (sort direction, show-hidden) is one icon — only ever one of the pair is visible.
  it('never exposes more than four navigation icons on any view, in any state', () => {
    const navEntries = titleMenus().filter((e) => e.group.startsWith('navigation'));
    for (const view of viewsOf(navEntries)) {
      const entries = navEntries.filter((e) => e.when.includes(`view == ${view}`));
      const togglePairs = entries.filter((a) =>
        a.when.includes('!') && entries.some((b) => b !== a && a.when.replace('!', '') === b.when),
      ).length;
      expect(entries.length - togglePairs, `${view} exposes too many navigation icons`).toBeLessThanOrEqual(4);
    }
  });

  // The header registers even when there is no MO2 instance, but the commands these three
  // activate are registered only alongside the Loadout views — so without this gate they are
  // icons that throw "command not found" on a non-MO2 folder.
  it.each(['modbench.launch', 'modbench.modList.deploy', 'modbench.modList.purge'])(
    '%s is withheld until the workspace is an MO2 instance', (command) => {
      const entries = titleMenus().filter((e) => e.command === command);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.when.includes('modbench.workspaceIsMo2Instance'))).toBe(true);
    });

  // Rule 4 again, on the one pair where the cost is highest: Save All and Revert All sat
  // side by side as identical-weight icons, one of them irreversible.
  it('keeps Revert All out of the navigation group while Save All stays an icon', () => {
    const revert = titleMenus().find((e) => e.command === 'modbench.revertAllGroups');
    const save = titleMenus().find((e) => e.command === 'modbench.saveAllGroups');
    expect(revert!.group.startsWith('navigation')).toBe(false);
    expect(save!.group).toBe('navigation@1');
  });

  // Rule 7: Collapse All belongs on a hierarchy and nowhere else — on a flat list it is an
  // icon that does nothing. `showCollapseAll` is a createTreeView option, so the assertion
  // lives with the wiring; here we only pin which views are hierarchical.
  it('the Mods tree and the editing Plugins tree are the hierarchical ones', () => {
    const sidebar = (pkg.contributes.views.modbench as { id: string }[]).map((v) => v.id);
    expect(sidebar).toContain('modbench.modList');
    expect(sidebar).toContain('modbench.pluginTree');
  });
});

describe('package.json standalone Deploy/Purge/Launch withdrawal (#186)', () => {
  it('defaults deploymentMode to external so the alpha never exposes standalone deploy without explicit opt-in', () => {
    const prop = pkg.contributes.configuration.properties['modbench.mods.deploymentMode'];
    expect(prop, 'expected modbench.mods.deploymentMode to still be declared').toBeTruthy();
    expect(prop.default).toBe('external');
  });

  it('removes the launchCommand setting — dead once Launch Game is withdrawn from the default path', () => {
    expect(pkg.contributes.configuration.properties['modbench.mods.launchCommand']).toBeUndefined();
  });

  it('gates Deploy/Purge/Launch Game in the command palette the same as the title bar, closing the Ctrl+Shift+P hole', () => {
    const palette = pkg.contributes.menus.commandPalette as { command: string; when: string }[];
    expect(palette, 'expected a contributes.menus.commandPalette section').toBeTruthy();

    // #247 retired modbench.modList.launchGame (deploy + spawn a hardcoded Fallout4.exe) in
    // favour of modbench.launch, which runs a contributed task. Same standalone-only gate.
    for (const command of ['modbench.modList.deploy', 'modbench.modList.purge', 'modbench.launch']) {
      const entry = palette.find((e) => e.command === command);
      expect(entry, `expected a commandPalette entry for ${command}`).toBeTruthy();
      // Same gate as the view/title button for this command, so palette and title bar can never diverge.
      const titleBarEntry = (pkg.contributes.menus['view/title'] as { command: string; when: string }[])
        .find((e) => e.command === command);
      expect(titleBarEntry, `expected a view/title entry for ${command}`).toBeTruthy();
      expect(titleBarEntry!.when).toContain(entry!.when);
    }
  });
});
