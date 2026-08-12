import { describe, it, expect, vi } from 'vitest';

// #247: the Loadout header is the home for workspace-scope actions — profile, session,
// deployment — none of which belong to any one tree's domain. It spans both bounded
// contexts (it starts Editing from a Mod-Management readout), so it may not import either
// context's internals: every piece of state arrives as an injected getter. That constraint
// is what makes it unit-testable here without a VS Code harness (`vi.mock('vscode')`, the
// reporter.test.ts precedent).
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    collapsibleState: number;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  EventEmitter: class {
    private readonly handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
}));

import { LoadoutHeaderProvider, type LoadoutHeaderDeps } from '../LoadoutHeaderProvider';

function makeProvider(overrides: Partial<LoadoutHeaderDeps> = {}) {
  return new LoadoutHeaderProvider({
    hasLoadout: () => true,
    activeProfile: () => Promise.resolve('Default'),
    sessionRunning: () => false,
    deployment: () => Promise.resolve('external' as const),
    ...overrides,
  });
}

describe('LoadoutHeaderProvider', () => {
  // The header registers on every path, including the ones where there is no loadout at all
  // (no workspace open, or a workspace that isn't an MO2 instance) — it is the container's
  // first view and must never be a hole. But on those paths the commands its rows activate
  // are never registered, so a row would be a click that throws "command not found". There
  // is nothing to read and nothing to run, so it renders nothing; the Mods view's existing
  // #192 welcome content is what tells the user why.
  it('renders no rows when there is no loadout to read', async () => {
    const rows = await makeProvider({ hasLoadout: () => false }).getChildren();

    expect(rows).toEqual([]);
  });

  it('reads the active profile as a row that activates Switch Profile', async () => {
    const [profile] = await makeProvider({ activeProfile: () => Promise.resolve('Survival') }).getChildren();

    expect(profile.description).toBe('Survival');
    expect((profile.command as { command: string }).command).toBe('modbench.modList.switchProfile');
  });

  it('offers Launch mEdit while no session is running', async () => {
    const [, session] = await makeProvider({ sessionRunning: () => false }).getChildren();

    expect(session.description).toBe('not running');
    expect((session.command as { command: string }).command).toBe('modbench.modList.launchMedit');
  });

  it('offers Close mEdit once a session is running — one row, one meaning, both directions', async () => {
    const [, session] = await makeProvider({ sessionRunning: () => true }).getChildren();

    expect(session.description).toBe('running');
    expect((session.command as { command: string }).command).toBe('modbench.closeMedit');
  });

  it('says nothing about deployment when an external manager owns it — no row, no launch affordance', async () => {
    const rows = await makeProvider({ deployment: () => Promise.resolve('external') }).getChildren();

    expect(rows).toHaveLength(2);
  });

  it('offers Deploy from the deployment row while nothing is deployed', async () => {
    const rows = await makeProvider({ deployment: () => Promise.resolve('notDeployed') }).getChildren();

    expect(rows).toHaveLength(3);
    expect(rows[2].description).toBe('not deployed');
    expect((rows[2].command as { command: string }).command).toBe('modbench.modList.deploy');
  });

  it('reads out a live deployment without offering Purge from the row — destructive actions stay in overflow behind a modal', async () => {
    const rows = await makeProvider({ deployment: () => Promise.resolve('deployed') }).getChildren();

    expect(rows[2].description).toBe('deployed');
    expect(rows[2].command).toBeUndefined();
  });
});
