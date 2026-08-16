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
  // against. The Mods tree, the Plugin load order and Downloads carry no view-mode gate at all.
  it.each(['modbench.modList', 'modbench.pluginListTree', 'modbench.downloads'])(
    '%s carries no view-mode gate, so it survives entering editing mode', (id) => {
      const view = sidebarViews().find((v) => v.id === id);
      expect(view!.when ?? '').not.toMatch(/modbench\.viewMode/);
    });

  it('drops the now-redundant view-mode clause from the "not an MO2 instance" welcome message', () => {
    const entry = welcome().find((w) => w.view === 'modbench.modList' && w.when.includes('workspaceIsMo2Instance'));
    expect(entry, 'expected the not-an-MO2-instance welcome entry').toBeTruthy();
    expect(entry!.when).not.toMatch(/modbench\.viewMode/);
  });
});

describe('package.json retires modbench.viewMode and the second Plugins view (#273 Slice C)', () => {
  const allViews = () => [
    ...(pkg.contributes.views.modbench as { id: string; name: string; when?: string }[]),
    ...(pkg.contributes.views.modbenchReferencedBy as { id: string; name: string; when?: string }[]),
  ];
  const allMenuEntries = () =>
    Object.values(pkg.contributes.menus as Record<string, { when?: string }[]>).flat();

  it('there is only one view named for plugins — modbench.pluginTree is gone', () => {
    expect(allViews().find((v) => v.id === 'modbench.pluginTree')).toBeUndefined();
    expect(allViews().filter((v) => v.name === 'Plugins')).toHaveLength(1);
    expect(allViews().filter((v) => v.name === 'Plugins')[0].id).toBe('modbench.pluginListTree');
  });

  it('Referenced By carries no gate at all — always present, like Mods/Plugins/Downloads', () => {
    const view = allViews().find((v) => v.id === 'modbench.referencedByTree');
    expect(view!.when).toBeUndefined();
  });

  it('no view, menu entry or keybinding references modbench.viewMode anywhere', () => {
    const offendingViews = allViews().filter((v) => (v.when ?? '').includes('modbench.viewMode'));
    const offendingMenus = allMenuEntries().filter((e) => (e.when ?? '').includes('modbench.viewMode'));
    const offendingKeybindings = (pkg.contributes.keybindings as { when?: string }[])
      .filter((k) => (k.when ?? '').includes('modbench.viewMode'));
    expect(offendingViews).toEqual([]);
    expect(offendingMenus).toEqual([]);
    expect(offendingKeybindings).toEqual([]);
  });

  // The remaining modbench.pluginTree when-clauses (filterPluginTree/newPlugin/setFilter/
  // clearFilter/openHeader title-bar and context-menu entries) are retargeted in Slices D/E —
  // see 'package.json every modbench.pluginTree reference is gone (#273 AC5 closure)' below for
  // the assertion that no when clause references it anywhere once those land.
});

describe('package.json New Plugin / record filter reachable from the merged tree (#273 Slice D)', () => {
  const titleMenus = () => pkg.contributes.menus['view/title'] as { command: string; when: string; group: string }[];
  const entryFor = (command: string) => titleMenus().find((e) => e.command === command && e.when.includes('modbench.pluginListTree'));

  // Fixed slot order (modbench/CLAUDE.md rule 5): name filter, then the view's state affordance
  // — the record filter is the merged tree's second narrowing axis — then domain actions.
  it('keeps modbench.pluginListTree.filter at slot 1 (unchanged by this slice)', () => {
    expect(entryFor('modbench.pluginListTree.filter')!.group).toBe('navigation@1');
  });

  it('places the record filter (setFilter/clearFilter) at slot 2', () => {
    expect(entryFor('modbench.setFilter')!.group).toBe('navigation@2');
    const clear = titleMenus().find((e) => e.command === 'modbench.clearFilter' && e.when.includes('modbench.pluginListTree'));
    expect(clear!.group).toBe('navigation@2');
    expect(clear!.when).toBe('view == modbench.pluginListTree && modbench.filterActive');
  });

  it('places New Plugin… at slot 3', () => {
    expect(entryFor('modbench.newPlugin')!.group).toBe('navigation@3');
  });
});

// Old modbench.pluginTree reached Open Header on 'plugin' and 'pluginImmutable' (medit's own
// read-only-master contextValue) rows. The merged tree's rows are modmanager/PluginListProvider's
// instead, whose two plugin-bearing contextValues are 'plugin' and 'pluginImplicit' — not the
// same string as 'pluginImmutable', and deliberately not reconciled with it here (#276's job).
describe('package.json Open Header reachable from every plugin-bearing row (#273 Slice E)', () => {
  const contextMenus = () => pkg.contributes.menus['view/item/context'] as { command: string; when: string; group: string }[];

  it.each(['modbench@1', 'inline'])('targets the merged tree, both plugin row kinds, group %s', (group) => {
    const entry = contextMenus().find((e) => e.command === 'modbench.openHeader' && e.group === group);
    expect(entry, `expected an openHeader entry in group ${group}`).toBeTruthy();
    expect(entry!.when).toBe('view == modbench.pluginListTree && (viewItem == plugin || viewItem == pluginImplicit)');
  });
});

describe('package.json every modbench.pluginTree reference is gone (#273 AC5 closure)', () => {
  // Slices C–E together retarget or delete every command the old view carried. This is the
  // full closure check condition 4 asked for: nothing left anywhere references the deleted id.
  it('no view, menu entry or keybinding references modbench.pluginTree anywhere', () => {
    const allMenuEntries = Object.values(pkg.contributes.menus as Record<string, { when?: string }[]>).flat();
    const offendingMenus = allMenuEntries.filter((e) => (e.when ?? '').includes('modbench.pluginTree'));
    const offendingKeybindings = (pkg.contributes.keybindings as { when?: string }[])
      .filter((k) => (k.when ?? '').includes('modbench.pluginTree'));
    const offendingViews = [
      ...(pkg.contributes.views.modbench as { id: string }[]),
      ...(pkg.contributes.views.modbenchReferencedBy as { id: string }[]),
    ].filter((v) => v.id === 'modbench.pluginTree');
    expect(offendingMenus).toEqual([]);
    expect(offendingKeybindings).toEqual([]);
    expect(offendingViews).toEqual([]);
  });
});

describe('package.json filtering is one UX (#247)', () => {
  const titleMenus = () => pkg.contributes.menus['view/title'] as { command: string; when: string; group: string }[];
  const commandTitle = (id: string) =>
    (pkg.contributes.commands as { command: string; title: string; icon?: string }[]).find((c) => c.command === id);

  // Every list view narrows by name the same way, through the same widget. Downloads was the
  // odd one out (#233 sent it to VS Code's native tree Find), which made the filter three
  // different answers across five title bars; one widget also gives #255 a single fix site.
  // #273 Slice D: modbench.pluginTree / modbench.filterPluginTree dropped out of this list —
  // that command duplicated modbench.pluginListTree.filter over the same rows (both narrowed
  // plugin rows by name) once the merged tree made the standalone editing Plugins tree
  // unreachable, so it was deleted rather than retargeted.
  const FILTERED_VIEWS = [
    ['modbench.modList', 'modbench.modList.filter'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filter'],
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
  // #273: the merged Plugins tree (modbench.pluginListTree) is the one that became hierarchical
  // under #270 — the standalone editing Plugins tree it superseded is gone.
  it('the Mods tree and the merged Plugins tree are the hierarchical ones', () => {
    const sidebar = (pkg.contributes.views.modbench as { id: string }[]).map((v) => v.id);
    expect(sidebar).toContain('modbench.modList');
    expect(sidebar).toContain('modbench.pluginListTree');
  });
});

// #259: cloud-upload read as "syncing to a remote" (saving a pending change writes to a local
// plugin file); discard read as an error/warning state rather than a plain discard. Save and
// Revert now share one glyph pair everywhere they appear — per-row inline actions and the
// view-title Save All / Revert All — even though Revert All's icon is declared but never
// rendered today (it sits in the `1_revert` overflow group, not navigation, per the title-bar
// rubric's rule 4; see the "keeps Revert All out of the navigation group" test above). Declaring
// it anyway keeps the pair consistent by construction and correct if it's ever promoted.
describe('package.json Pending Changes row action icons (#259)', () => {
  const commandTitle = (id: string) =>
    (pkg.contributes.commands as { command: string; icon?: string }[]).find((c) => c.command === id);

  it.each(['modbench.saveGroup', 'modbench.saveAllGroups'])(
    '%s uses $(save) — a plain save affordance, not cloud-upload', (command) => {
      expect(commandTitle(command)!.icon).toBe('$(save)');
    });

  it.each(['modbench.revertGroup', 'modbench.revertAllGroups'])(
    '%s uses $(close) — a plain X, not the discard/error read', (command) => {
      expect(commandTitle(command)!.icon).toBe('$(close)');
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

// #280: the legacy block hardcoded "Modbench: " into `title` (leaking into every context menu it
// appeared in — "Modbench: Delete Record" on a tree row); the newer block set `category:
// "Modbench"` with a bare `title` instead, letting VS Code compose "Modbench: <title>" for the
// palette while context menus render the bare title. This closes every command onto that second,
// correct shape — category is metadata independent of palette visibility (it changes nothing in
// a context menu, which always renders the bare title), so every command gets one even when also
// gated out of the palette below.
describe('package.json command titles and categories (#280)', () => {
  const commands = pkg.contributes.commands as { command: string; title: string; category?: string }[];
  const palette = pkg.contributes.menus.commandPalette as { command: string; when: string }[];

  it('no title carries the hardcoded "Modbench: " palette prefix — category supplies it instead', () => {
    const offenders = commands.filter((c) => c.title.startsWith('Modbench: '));
    expect(offenders.map((c) => c.command)).toEqual([]);
  });

  it('every modbench.* command declares category "Modbench", independent of palette visibility', () => {
    const offenders = commands.filter((c) => c.category !== 'Modbench');
    expect(offenders.map((c) => c.command)).toEqual([]);
  });

  // These only do something when invoked with a tree/webview argument the Command Palette never
  // supplies (no formKey, no ctx, no clicked node) — and unlike modbench.deleteRecord (falls back
  // to a tracked tree selection) or modbench.referencedByTree.copy (falls back to the view's own
  // selection), none of these has an ambient fallback. Left live, each is either a silent no-op
  // or — modbench.copyAsOverrideInto — a guaranteed "No record selected." toast: a palette entry
  // whose only possible outcome is an error costs a user a click to discover, for nothing (AC5).
  // modbench.showReferencedBy is deliberately absent: post-#282 it takes no argument at all
  // (focuses the Referenced By view) and always works from the palette — the issue's own cited
  // no-op example is stale.
  // Exhaustive both ways, same "nothing missing, nothing extra" shape as EXPECTED_COMMANDS.
  const PALETTE_GATED = [
    'modbench.openHeader',
    'modbench.createPlaced',
    'modbench.saveGroup',
    'modbench.revertGroup',
    'modbench.copyAsOverrideInto',
    'modbench.pendingCell.reveal',
    'modbench.pendingCell.saveGroup',
    'modbench.pendingCell.revertGroup',
    'modbench.copyAsNewRecord',
    'modbench.array.add',
    'modbench.array.remove',
    'modbench.array.moveUp',
    'modbench.array.moveDown',
    'modbench.vmad.addScript',
    'modbench.vmad.removeScript',
    'modbench.vmad.addProperty',
    'modbench.vmad.removeProperty',
    'modbench.vmad.setScriptFlags',
    'modbench.vmad.setPropertyFlags',
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
  ] as const;

  it('gates exactly the commands that cannot work without a tree/webview argument out of the palette', () => {
    expect(PALETTE_GATED).toHaveLength(36);
    const gatedFalse = new Set(palette.filter((e) => e.when === 'false').map((e) => e.command));
    const missingGate = PALETTE_GATED.filter((c) => !gatedFalse.has(c));
    const unexpectedGate = [...gatedFalse].filter((c) => !(PALETTE_GATED as readonly string[]).includes(c));
    expect(missingGate).toEqual([]);
    expect(unexpectedGate).toEqual([]);
  });
});

// #281: one object, one context menu. The record-scoped actions — the copy family and Remove —
// are the same command ids, in xEdit's pmuViewHeader order (copy as override, copy as new record,
// remove — ADR-0034), on every surface that shows a record: the tree's record row, the placed row
// and the record editor's column header. Adding a record action means adding it to every surface
// or this fails.
describe('package.json one record menu on every record surface (#281)', () => {
  const menus = pkg.contributes.menus as Record<string, { command: string; when: string; group?: string }[]>;
  const RECORD_MENU = ['modbench.copyAsOverrideInto', 'modbench.copyAsNewRecord', 'modbench.deleteRecord'];
  const COPY_ONLY = RECORD_MENU.slice(0, 2);

  /** The #281 record actions contributed for a given tree contextValue, in group order. */
  function treeRecordMenu(viewItem: string): string[] {
    const mentions = new RegExp(`viewItem == ${viewItem}\\b`);
    return (menus['view/item/context'] ?? [])
      .filter((e) => e.when.includes('modbench.pluginListTree') && mentions.test(e.when))
      .filter((e) => RECORD_MENU.includes(e.command))
      .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '', undefined, { numeric: true }))
      .map((e) => e.command);
  }

  /** The #281 record actions on the column header, in group order. */
  function columnHeaderMenu(): { command: string; when: string }[] {
    return (menus['webview/context'] ?? [])
      .filter((e) => e.when.includes("webviewSection == 'columnHeader'"))
      .filter((e) => RECORD_MENU.includes(e.command))
      .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '', undefined, { numeric: true }));
  }

  it('offers the same record actions, in the same order, on record rows, placed rows and the column header', () => {
    expect(treeRecordMenu('record')).toEqual(RECORD_MENU);
    expect(treeRecordMenu('refr')).toEqual(RECORD_MENU);
    expect(columnHeaderMenu().map((e) => e.command)).toEqual(RECORD_MENU);
  });

  it('hides Remove for an immutable copy on every surface, keeping the copy family', () => {
    expect(treeRecordMenu('recordImmutable')).toEqual(COPY_ONLY);
    expect(treeRecordMenu('refrImmutable')).toEqual(COPY_ONLY);
    const remove = columnHeaderMenu().find((e) => e.command === 'modbench.deleteRecord');
    expect(remove?.when).toContain('!immutable');
  });

  it('one operation, one name: the command is titled "Remove" and the old per-surface ids are gone', () => {
    const commands = pkg.contributes.commands as { command: string; title: string }[];
    expect(commands.find((c) => c.command === 'modbench.deleteRecord')?.title).toBe('Remove');
    const ids = new Set(commands.map((c) => c.command));
    expect(ids.has('modbench.columnHeader.removeOverride')).toBe(false);
    expect(ids.has('modbench.columnHeader.copyAsNewRecord')).toBe(false);
    for (const [menuId, entries] of Object.entries(menus)) {
      for (const gone of ['modbench.columnHeader.removeOverride', 'modbench.columnHeader.copyAsNewRecord']) {
        expect(
          entries.some((e) => e.command === gone),
          `expected no "${menuId}" entry invoking ${gone}`,
        ).toBe(false);
      }
    }
  });
});
