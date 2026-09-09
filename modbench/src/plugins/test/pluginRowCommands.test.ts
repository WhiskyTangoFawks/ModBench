import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, showInformationMessage, showWarningMessage, showErrorMessage, withProgress,
  TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  // `PluginTreeProvider.ts` is a value import three hops down (for its node classes' own
  // `vscode.TreeItem` base) — these stubs exist only so that module chain loads, not for this
  // file's own assertions.
  class TreeItem { label?: unknown; collapsibleState?: unknown; constructor(label?: unknown, collapsibleState?: unknown) { this.label = label; this.collapsibleState = collapsibleState; } }
  class ThemeIcon { id: string; constructor(id: string) { this.id = id; } }
  class EventEmitter { event = () => {}; fire = () => {}; }
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn((_options: unknown, work: () => Promise<unknown>) => work()),
    TreeItem, ThemeIcon, EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick, showInformationMessage, showWarningMessage, showErrorMessage, withProgress },
  TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState,
}));

import {
  registerTrackCommand, registerRebaseCommand, compileAndReport, registerSaveAndCompileCommand, registerCompileAtRefCommand,
} from '../pluginRowCommands';
import { InMemoryMEditClient } from '../../medit/client';
import type { PluginListNode } from '../PluginsTreeProvider';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function pluginNode(name = 'MyMod.esp'): PluginListNode {
  return { kind: 'plugin', plugin: { name } } as any;
}

function clientWithOrigin(name: string, origin: string): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [{ name, origin, inLoadOrder: true } as any]);
  return client;
}

// ── registerTrackCommand ──────────────────────────────────────────────────

describe('registerTrackCommand', () => {
  function invokeTrack(client: InMemoryMEditClient, treeProvider: any, onTracked = vi.fn().mockResolvedValue(undefined)) {
    const session = { pluginsTreeView: undefined, pluginsNameFilter: undefined } as any;
    registerTrackCommand(session, client, fakeOutputChannel(), treeProvider, onTracked);
    return { handler: handlers.get('modbench.pluginListTree.track')!, onTracked };
  }

  it('refreshes the tree and shows the tracked toast on a landed track', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { origin: 'ModA' });
    const treeProvider = { refresh: vi.fn() };
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked } = invokeTrack(client, treeProvider);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: ['ModA', 'Edits', expect.anything()] });
    expect(treeProvider.refresh).toHaveBeenCalledOnce();
    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Tracked "ModA".');
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: showing the toast and refreshing on a refusal too would tell the user a track
  // landed when the backend actually said "already tracked."
  it('shows the ready-to-show message and refreshes nothing when the backend refuses the track', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'mEdit: Could not track "ModA" — already tracked' } as any);
    const treeProvider = { refresh: vi.fn() };
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked } = invokeTrack(client, treeProvider);

    await handler(pluginNode());

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not track "ModA" — already tracked');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(onTracked).not.toHaveBeenCalled();
  });
});

// ── registerRebaseCommand ──────────────────────────────────────────────────

describe('registerRebaseCommand', () => {
  function invokeRebase(client: InMemoryMEditClient) {
    const treeProvider = { refresh: vi.fn() } as any;
    const refreshMatchingPlugins = vi.fn();
    registerRebaseCommand(client, fakeOutputChannel(), treeProvider, refreshMatchingPlugins);
    return { handler: handlers.get('modbench.pluginListTree.rebase')!, treeProvider, refreshMatchingPlugins };
  }

  it('shows the clean-rebase toast and refreshes on a landed rebase', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Clean', refusalReason: null, conflictedPaths: [] } as any);
    const { handler, treeProvider, refreshMatchingPlugins } = invokeRebase(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'rebaseOntoMain', args: ['ModA'] });
    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Rebased "ModA" onto the updated baseline.');
    expect(treeProvider.refresh).toHaveBeenCalledOnce();
    expect(refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses the rebase outright', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { refused: true, message: 'mEdit: Could not rebase "ModA" — boom' } as any);
    const { handler, treeProvider, refreshMatchingPlugins } = invokeRebase(client);

    await handler(pluginNode());

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not rebase "ModA" — boom');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});

// ── compileAndReport ───────────────────────────────────────────────────────

describe('compileAndReport', () => {
  it('shows the ready-to-show message on a transport-level refusal (WriteRefused), never the typed-refusal wording', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' } as any);
    const diagnostics = { delete: vi.fn(), set: vi.fn(), [Symbol.iterator]: function* () {} } as any;

    await compileAndReport(client, diagnostics, { name: 'MyPatch.esp', origin: 'ModA' }, undefined);

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not compile "MyPatch.esp" — boom');
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});

function fakeDiagnostics() {
  return { delete: vi.fn(), set: vi.fn(), [Symbol.iterator]: function* () {} } as any;
}

// ── registerSaveAndCompileCommand ─────────────────────────────────────────

describe('registerSaveAndCompileCommand', () => {
  it('drives a tree-row compile through the registered command, recording the compile call and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' } as any);
    const activeRecordTracker = { current: () => undefined } as any;
    const diagnostics = fakeDiagnostics();
    registerSaveAndCompileCommand(client, activeRecordTracker, fakeOutputChannel(), diagnostics);

    await handlers.get('modbench.saveAndCompile')!({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not compile "MyPatch.esp" — boom');
  });
});

// ── registerCompileAtRefCommand ───────────────────────────────────────────

describe('registerCompileAtRefCommand', () => {
  it('drives a compile-at-main through the registered command, recording the compile call at "main" and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" at "main" — boom' } as any);
    const diagnostics = fakeDiagnostics();
    showWarningMessage.mockResolvedValue('Compile at main');
    registerCompileAtRefCommand(client, fakeOutputChannel(), diagnostics);

    await handlers.get('modbench.pluginListTree.compileAtMain')!({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', 'main'] });
    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not compile "MyPatch.esp" at "main" — boom');
  });
});
