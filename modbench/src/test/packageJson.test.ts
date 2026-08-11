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

describe('package.json standalone Deploy/Purge/Launch Game withdrawal (#186)', () => {
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

    for (const command of ['modbench.modList.deploy', 'modbench.modList.purge', 'modbench.modList.launchGame']) {
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
