import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from './vscodeMock';

// The Toolbox renders the Instance's value and nothing else: no disk read, no backend state.
vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { ToolboxProvider, type ToolboxDeps, type ToolboxState } from '../ToolboxProvider';

const VALUE: ToolboxState = { activeProfile: 'Default', deployed: false };

function makeProvider(overrides: Partial<ToolboxDeps> = {}) {
  return new ToolboxProvider({
    state: () => VALUE,
    ...overrides,
  });
}

describe('ToolboxProvider', () => {
  // The view registers even where there is no instance, since it is the container's first view.
  // On those paths its rows' commands are unregistered, so a row would throw "command not found".
  it('renders no rows when there is no instance to read', () => {
    expect(makeProvider({ state: () => undefined }).getChildren()).toEqual([]);
  });

  // Launch mEdit / Close mEdit belong to the Plugins view — the Toolbox carries no mEdit row.
  it('never renders an mEdit row', () => {
    const rows = makeProvider().getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Profile', 'Deployment']);
  });

  it('refresh() fires the change event VS Code re-renders the tree on', () => {
    const provider = makeProvider();
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e) => fired.push(e));

    provider.refresh();

    expect(fired).toEqual([undefined]);
  });

  it('reads the active profile out of the value as a row that activates Switch Profile', () => {
    const [profile] = makeProvider({ state: () => ({ activeProfile: 'Survival', deployed: false }) }).getChildren();

    expect(profile.description).toBe('Survival');
    expect((profile.command as { command: string }).command).toBe('modbench.modList.switchProfile');
  });

  // Rival: a row that reads the profile from anywhere but the value — the pre-first-read value
  // names no profile, and the row must say so rather than inventing one.
  it('reads out an em-dash while the value names no profile yet', () => {
    const [profile] = makeProvider({ state: () => ({ activeProfile: '', deployed: false }) }).getChildren();

    expect(profile.description).toBe('—');
  });

  it('offers Deploy from the deployment row while the value says nothing is deployed', () => {
    const rows = makeProvider({ state: () => ({ activeProfile: 'Default', deployed: false }) }).getChildren();

    expect(rows).toHaveLength(2);
    expect(rows[1].description).toBe('not deployed');
    expect((rows[1].command as { command: string }).command).toBe('modbench.modList.deploy');
  });

  it('reads out a live deployment without offering Purge from the row — destructive actions stay in overflow behind a modal', () => {
    const rows = makeProvider({ state: () => ({ activeProfile: 'Default', deployed: true }) }).getChildren();

    expect(rows[1].description).toBe('deployed');
    expect(rows[1].command).toBeUndefined();
  });
});
