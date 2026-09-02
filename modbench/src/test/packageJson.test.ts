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

  // Unset context keys read falsy under `!key`, so before activation ever runs,
  // `!modbench.workspaceIsMo2Instance` is indistinguishable from a real "checked, not an
  // instance" result — the welcome would render for every workspace, valid or not, until the
  // extension activated. modbench.workspaceMo2CheckDone is a second key set only once the
  // check has actually run (extension.ts's mo2InstanceContext, on every exit path), so an
  // unset check can never satisfy this clause. Exact-match, not .toContain: a loose
  // substring check can't tell `modbench.workspaceMo2CheckDone` from
  // `!modbench.workspaceMo2CheckDone` — the exact string can, and a rival that negates
  // either term must fail here.
  it('cannot render before the MO2 check has actually run (#554)', () => {
    const welcome = (pkg.contributes.viewsWelcome as { view: string; when: string }[])
      .find((w) => w.view === 'modbench.modList');
    expect(welcome!.when).toBe(
      'workspaceFolderCount != 0 && modbench.workspaceMo2CheckDone && !modbench.workspaceIsMo2Instance',
    );
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
});

// VS Code has no view nesting/grouping within a container, so a "Plugins - " title prefix is the
// only available way to say Referenced By is sub-functionality of the one Plugins tree, not a
// sibling of equal standing (ADR-0035).
describe('package.json "Plugins - …" naming for Referenced By (#273 Slice B)', () => {
  it('names the Referenced By view "Plugins - Referenced By"', () => {
    const referencedByViews = pkg.contributes.views.modbenchReferencedBy as { id: string; name: string }[];
    const view = referencedByViews.find((v) => v.id === 'modbench.referencedByTree');
    expect(view!.name).toBe('Plugins - Referenced By');
  });
});

describe('package.json Loadout views stay visible through an editing backend (#268)', () => {
  const welcome = () => pkg.contributes.viewsWelcome as { view: string; when: string }[];

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

// There is no Open Header button (context menu entry or inline icon) — xEdit parity
// (vstNavChange / TryViewOrCompareSelectedRecords, xeMainForm.pas: selecting a plugin node shows
// its File Header as a matter of course, no separate affordance) means selecting/clicking a
// plugin row opens its header directly (PluginNode/ImplicitMasterNode wire `.command` to
// modbench.openHeader themselves — modmanager/PluginListProvider.ts). The command survives, as
// the row-click's own bridge implementation, palette-gated (see PALETTE_GATED below) — only its
// former UI affordance is gone.
describe('package.json Open Header has no button of its own — row click replaces it (#345)', () => {
  const contextMenus = () => pkg.contributes.menus['view/item/context'] as { command: string; when: string; group: string }[];

  it('contributes no context-menu or inline entry for modbench.openHeader', () => {
    expect(contextMenus().filter((e) => e.command === 'modbench.openHeader')).toEqual([]);
  });

  it('modbench.openHeader itself is still declared — the row-click bridge command, not a button', () => {
    const commands = pkg.contributes.commands as { command: string }[];
    expect(commands.some((c) => c.command === 'modbench.openHeader')).toBe(true);
  });
});

describe('package.json filtering is one UX (#247)', () => {
  const titleMenus = () => pkg.contributes.menus['view/title'] as { command: string; when: string; group: string }[];
  const commandTitle = (id: string) =>
    (pkg.contributes.commands as { command: string; title: string; icon?: string }[]).find((c) => c.command === id);

  // Every list view narrows by name the same way, through the same widget — one filter answer
  // across every title bar, and a single fix site.
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

  // The filter is durable, so it needs a way out — the established two-command +
  // context-key toggle template (sort direction, show-hidden), so slot 1 shows exactly one of
  // the pair at a time. The key is per view: the record filter's `modbench.filterActive` is a
  // different, independently-clearable axis on the same title bar.
  const DURABLE_FILTERS = [
    ['modbench.modList', 'modbench.modList.filter', 'modbench.modList.clearFilter', 'modbench.modList.filterActive'],
    ['modbench.pluginListTree', 'modbench.pluginListTree.filter', 'modbench.pluginListTree.clearFilter', 'modbench.pluginListTree.filterActive'],
    ['modbench.downloads', 'modbench.downloads.filter', 'modbench.downloads.clearFilter', 'modbench.downloads.filterActive'],
  ] as const;

  it.each(DURABLE_FILTERS)('%s swaps slot 1 to its clear variant while a filter is active', (view, open, clearCommand, key) => {
    const openEntry = titleMenus().find((e) => e.command === open && e.when.includes(`view == ${view}`));
    const clearEntry = titleMenus().find((e) => e.command === clearCommand && e.when.includes(`view == ${view}`));
    expect(clearEntry, `expected ${clearCommand} on ${view}`).toBeTruthy();
    expect(openEntry!.when).toBe(`view == ${view} && !${key}`);
    expect(clearEntry!.when).toBe(`view == ${view} && ${key}`);
    expect(clearEntry!.group).toBe('navigation@1');
  });

  // $(clear-all) is what VS Code's own Extensions view uses for "Clear Extensions Search
  // Results" — clearing a text filter on a list. $(search-stop) was rejected: it means halting a
  // search in progress, which would imply the results stay. The title-bar icon rubric may
  // override this; it is recorded here rather than silently inherited.
  it.each(DURABLE_FILTERS)('%s clears with $(clear-all)', (_view, _open, clearCommand) => {
    expect(commandTitle(clearCommand)!.icon).toBe('$(clear-all)');
  });

  // `ctrl+F` means find-within-the-focused-surface everywhere else in VS Code (editor,
  // terminal, Output, debug console). Trees left it unbound when `list.find` moved to
  // `ctrl+alt+F` in 1.89, so a per-view `focusedView` binding conflicts with nothing and closes
  // the one surface where the platform's own idiom silently does nothing.
  it.each(DURABLE_FILTERS)('%s opens its filter on ctrl+F while focused', (view, openCommand) => {
    const keybindings = pkg.contributes.keybindings as { command: string; key: string; when: string }[];
    const entry = keybindings.find((k) => k.command === openCommand);
    expect(entry, `expected a ctrl+F binding for ${openCommand}`).toBeTruthy();
    expect(entry!.key).toBe('ctrl+f');
    expect(entry!.when).toBe(`focusedView == ${view}`);
  });

  // Scoped to the focused view, never the container or the window: an unscoped ctrl+F would
  // shadow the editor's own Find for the whole workbench.
  it('never binds ctrl+F outside a specific focused view', () => {
    const keybindings = pkg.contributes.keybindings as { command: string; key: string; when?: string }[];
    const unscoped = keybindings.filter((k) => k.key === 'ctrl+f' && !k.when?.startsWith('focusedView == '));
    expect(unscoped.map((k) => k.command)).toEqual([]);
  });
});

describe('package.json Refresh is one command (#247)', () => {
  const titleMenus = () => pkg.contributes.menus['view/title'] as { command: string; when: string; group: string }[];

  // Refresh is workspace-scope (re-read what is on disk), so it belongs to the header, once —
  // never one Refresh per tree.
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

});

describe('package.json title-bar rubric (#247)', () => {
  type MenuEntry = { command: string; when: string; group: string };
  const titleMenus = () => pkg.contributes.menus['view/title'] as MenuEntry[];
  const viewsOf = (entries: MenuEntry[]) =>
    new Set(entries.map((e) => /view == ([\w.]+)/.exec(e.when)?.[1]).filter(Boolean) as string[]);

  // Rule 1, scope first: an action that isn't about this tree's own domain doesn't go on this
  // tree. These three are workspace-scope — they swap the modlist or act on the whole
  // deployment. (There is no Reload Load Order: ADR-0044 reconciles the load order on every
  // change, so there is nothing to reload.) There is no Launch/Close mEdit anywhere: the
  // backend launches with the extension (maintainer ruling 2026-09-01 — the DB-file-backed
  // session made startup cheap enough that lifecycle stopped being a user decision).
  const WORKSPACE_ACTIONS = [
    'modbench.modList.switchProfile',
    'modbench.modList.deploy',
    'modbench.modList.purge',
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

  // Rule 7: Collapse All belongs on a hierarchy and nowhere else — on a flat list it is an
  // icon that does nothing. `showCollapseAll` is a createTreeView option, so the assertion
  // lives with the wiring; here we only pin which views are hierarchical.
  it('the Mods tree and the merged Plugins tree are the hierarchical ones', () => {
    const sidebar = (pkg.contributes.views.modbench as { id: string }[]).map((v) => v.id);
    expect(sidebar).toContain('modbench.modList');
    expect(sidebar).toContain('modbench.pluginListTree');
  });
});

// mEdit isn't a universal option, it's an option on the Plugins view — so its affordance
// lives on the one Plugins tree, not the Loadout header.
// Placement is overflow, not a navigation icon: rule 2's own ceiling test
// above already measures modbench.pluginListTree at its 4-icon maximum before this pair is
// added — a two-command toggle still "counts as one icon" per rule 2, but that accounting
// only matters once there is a free slot to spend it on, and rule 5's own slot sequence ends
// "then overflow" for whatever arrives once domain-action slots are exhausted.
describe('package.json standalone Deploy/Purge/Launch withdrawal (#186)', () => {
  it('defaults deploymentMode to external so the alpha never exposes standalone deploy without explicit opt-in', () => {
    const prop = pkg.contributes.configuration.properties['modbench.mods.deploymentMode'];
    expect(prop, 'expected modbench.mods.deploymentMode to still be declared').toBeTruthy();
    expect(prop.default).toBe('external');
  });

  it('gates Deploy/Purge/Launch Game in the command palette the same as the title bar, closing the Ctrl+Shift+P hole', () => {
    const palette = pkg.contributes.menus.commandPalette as { command: string; when: string }[];
    expect(palette, 'expected a contributes.menus.commandPalette section').toBeTruthy();

    // modbench.launch runs a contributed task, never a hardcoded game exe. Same
    // standalone-only gate as Deploy/Purge.
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

// A hardcoded "Modbench: " in `title` leaks into every context menu the command appears
// in — "Modbench: Delete Record" on a tree row. `category:
// "Modbench"` with a bare `title` instead lets VS Code compose "Modbench: <title>" for the
// palette while context menus render the bare title. Every command takes that
// shape — category is metadata independent of palette visibility (it changes nothing in
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
  // modbench.showReferencedBy is deliberately absent: it takes no argument at all
  // (focuses the Referenced By view) and always works from the palette.
  // Exhaustive both ways, same "nothing missing, nothing extra" shape as EXPECTED_COMMANDS.
  const PALETTE_GATED = [
    'modbench.openHeader',
    // Each needs the clicked cell's own row/column identity from its
    // data-vscode-context — no ambient fallback worth a QuickPick-over-QuickPick, same posture as
    // the tree-row-gated commands below.
    'modbench.array.add',
    'modbench.array.remove',
    'modbench.array.moveUp',
    'modbench.array.moveDown',
    // Same posture as the array-op commands above — each needs the clicked VMAD
    // row's own script/property identity from its data-vscode-context, no ambient fallback.
    'modbench.vmad.addScript',
    'modbench.vmad.removeScript',
    'modbench.vmad.addProperty',
    'modbench.vmad.removeProperty',
    'modbench.vmad.setScriptFlags',
    'modbench.vmad.setPropertyFlags',
    // ADR-0039: needs the clicked string cell's own identity/value/readOnly from its
    // data-vscode-context — no ambient fallback, same posture as the array/VMAD ops above.
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
    // Reached from a plugins-tree record row (RecordNode) or the record editor's own
    // column header (ColumnHeaderContext, via its data-vscode-context) — neither has an ambient
    // fallback worth a QuickPick-over-QuickPick, same posture as every other tree/webview-argument
    // command above.
    'modbench.record.copyAsOverride',
    'modbench.record.copyAsNewRecord',
  ] as const;

  it('gates exactly the commands that cannot work without a tree/webview argument out of the palette', () => {
    expect(PALETTE_GATED).toHaveLength(37);
    const gatedFalse = new Set(palette.filter((e) => e.when === 'false').map((e) => e.command));
    const missingGate = PALETTE_GATED.filter((c) => !gatedFalse.has(c));
    const unexpectedGate = [...gatedFalse].filter((c) => !(PALETTE_GATED as readonly string[]).includes(c));
    expect(missingGate).toEqual([]);
    expect(unexpectedGate).toEqual([]);
  });
});

// #572 ruling 1: Change FormID exists only on a master record in a tracked plugin — an override
// row (contextValue recordOverride) or an untracked one (recordImmutable) never offers it, while
// the other record actions stay available there where they are legal.
describe('package.json record-row context menu — renumber gated to native tracked rows (#572)', () => {
  const contextMenus = () => pkg.contributes.menus['view/item/context'] as { command: string; when: string }[];
  const whenOf = (command: string) => contextMenus().find((e) => e.command === command)!.when;

  it('offers Change FormID only on viewItem == record', () => {
    expect(whenOf('modbench.record.renumber')).toBe('view == modbench.pluginListTree && viewItem == record');
  });

  it('offers Remove on override rows too', () => {
    expect(whenOf('modbench.record.delete')).toContain('recordOverride');
  });

  it('offers both copy gestures on override rows too', () => {
    expect(whenOf('modbench.record.copyAsOverride')).toContain('recordOverride');
    expect(whenOf('modbench.record.copyAsNewRecord')).toContain('recordOverride');
  });
});

// Origin drift is absorbed automatically by the reconcile verb (ADR-0044) — there is nothing for
// a plugin row to be, or offer, beyond the two contextValues `PluginListProvider` itself produces
// (`plugin`, `pluginImplicit`); there is no manual re-read gesture.
describe('package.json plugin-row context menu', () => {
  const contextMenus = () => pkg.contributes.menus['view/item/context'] as { command: string; when: string; group: string }[];
  const forPluginRows = () => contextMenus().filter((e) => e.when.includes('viewItem == plugin'));

  // The enumeration, kept honest: every command reachable from a plugin row, listed, with
  // exactly one contextValue (`plugin`). Open Header has no
  // entries here — it opens via row click (PluginNode/ImplicitMasterNode's own
  // `.command`), not a context/inline menu entry, so it does not appear in this enumeration.
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

// ADR-0041: the Track gesture's own menu contribution.
describe('package.json per-plugin Track (#414)', () => {
  const contextMenus = () => pkg.contributes.menus['view/item/context'] as { command: string; when: string; group: string }[];

  it('sits below the other row actions in the same row-action group', () => {
    const entry = contextMenus().find((e) => e.command === 'modbench.pluginListTree.track');
    expect(entry).toBeTruthy();
    expect(entry!.group).toBe('pluginActions@2');
  });

  // No icon: Track is a one-time, deliberately weighty gesture (ADR-0041: "deliberate friction"),
  // not a quick inline action.
  it('never appears as an inline or navigation icon', () => {
    const inline = contextMenus().filter((e) => e.command === 'modbench.pluginListTree.track' && e.group === 'inline');
    const title = (pkg.contributes.menus['view/title'] as { command: string }[])
      .filter((e) => e.command === 'modbench.pluginListTree.track');
    expect([...inline, ...title]).toEqual([]);
  });
});

// "Open Editor to the Side" is reachable from the Referenced By tree's group rows and from
// the Plugins tree's record and placed-reference rows — single or multi-selected.
describe('package.json "Open Editor to the Side" reachable from Plugins tree record rows (#284)', () => {
  const contextMenus = () => pkg.contributes.menus['view/item/context'] as { command: string; when: string; group: string }[];

  it('offers modbench.openEditorBeside on record, recordImmutable, refr and refrImmutable rows', () => {
    const entry = contextMenus().find((e) =>
      e.command === 'modbench.openEditorBeside' && e.when.includes('modbench.pluginListTree'));
    expect(entry, 'expected a modbench.openEditorBeside entry on the Plugins tree').toBeTruthy();
    expect(entry!.when).toBe(
      'view == modbench.pluginListTree && (viewItem == record || viewItem == recordOverride || viewItem == recordImmutable || viewItem == refr || viewItem == refrImmutable)');
  });

  it('leaves the Referenced By group row\'s own existing entry untouched', () => {
    const entry = contextMenus().find((e) =>
      e.command === 'modbench.openEditorBeside' && e.when.includes('referencedByTree'));
    expect(entry).toBeTruthy();
    expect(entry!.when).toBe('view == modbench.referencedByTree && viewItem == referencedByGroup');
    expect(entry!.group).toBe('modbench@2');
  });
});
