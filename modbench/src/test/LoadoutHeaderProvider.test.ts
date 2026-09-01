import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from './vscodeMock';

// The Loadout header is the home for workspace-scope actions — profile, deployment —
// none of which belong to any one tree's domain. It spans both bounded contexts, so it may
// not import either context's internals: every piece of state arrives as an injected getter.
// That constraint is what makes it unit-testable here without a VS Code harness
// (`vi.mock('vscode')`, the reporter.test.ts precedent).
vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { LoadoutHeaderProvider, type LoadoutHeaderDeps } from '../LoadoutHeaderProvider';

function makeProvider(overrides: Partial<LoadoutHeaderDeps> = {}) {
  return new LoadoutHeaderProvider({
    hasLoadout: () => true,
    activeProfile: () => Promise.resolve('Default'),
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
  // welcome content is what tells the user why.
  it('renders no rows when there is no loadout to read', async () => {
    const rows = await makeProvider({ hasLoadout: () => false }).getChildren();

    expect(rows).toEqual([]);
  });

  // Launch mEdit / Close mEdit belong to the Plugins view — the header carries no mEdit
  // row at all.
  it('never renders an mEdit row', async () => {
    const rows = await makeProvider().getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Profile']);
    expect(rows.some((r) => r.label === 'mEdit')).toBe(false);
  });

  it('refresh() fires the change event VS Code re-renders the tree on', () => {
    const provider = makeProvider();
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    provider.refresh();

    expect(fired).toEqual([undefined]);
  });

  it('reads the active profile as a row that activates Switch Profile', async () => {
    const [profile] = await makeProvider({ activeProfile: () => Promise.resolve('Survival') }).getChildren();

    expect(profile.description).toBe('Survival');
    expect((profile.command as { command: string }).command).toBe('modbench.modList.switchProfile');
  });

  it('says nothing about deployment when an external manager owns it — no row, no launch affordance', async () => {
    const rows = await makeProvider({ deployment: () => Promise.resolve('external') }).getChildren();

    expect(rows).toHaveLength(1);
  });

  it('offers Deploy from the deployment row while nothing is deployed', async () => {
    const rows = await makeProvider({ deployment: () => Promise.resolve('notDeployed') }).getChildren();

    expect(rows).toHaveLength(2);
    expect(rows[1].description).toBe('not deployed');
    expect((rows[1].command as { command: string }).command).toBe('modbench.modList.deploy');
  });

  it('reads out a live deployment without offering Purge from the row — destructive actions stay in overflow behind a modal', async () => {
    const rows = await makeProvider({ deployment: () => Promise.resolve('deployed') }).getChildren();

    expect(rows[1].description).toBe('deployed');
    expect(rows[1].command).toBeUndefined();
  });
});
