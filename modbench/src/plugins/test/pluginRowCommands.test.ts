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

import { registerTrackCommand, registerRebaseCommand } from '../pluginRowCommands';
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

// ── registerTrackCommand ──────────────────────────────────────────────────

describe('registerTrackCommand', () => {
  function invokeTrack(controller: any, treeProvider: any, onTracked = vi.fn().mockResolvedValue(undefined)) {
    const session = { pluginsTreeView: undefined, pluginsNameFilter: undefined } as any;
    registerTrackCommand(session, controller, fakeOutputChannel(), treeProvider, onTracked);
    return { handler: handlers.get('modbench.pluginListTree.track')!, onTracked };
  }

  it('refreshes the tree and shows the tracked toast on a landed track', async () => {
    const controller = { resolveOrigin: vi.fn().mockResolvedValue('ModA'), track: vi.fn().mockResolvedValue({ origin: 'ModA' }) };
    const treeProvider = { refresh: vi.fn() };
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked } = invokeTrack(controller, treeProvider);

    await handler(pluginNode());

    expect(treeProvider.refresh).toHaveBeenCalledOnce();
    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Tracked "ModA".');
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: showing the toast and refreshing on a refusal too would tell the user a track
  // landed when the backend actually said "already tracked."
  it('shows the ready-to-show message and refreshes nothing when the backend refuses the track', async () => {
    const controller = {
      resolveOrigin: vi.fn().mockResolvedValue('ModA'),
      track: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not track "ModA" — already tracked' }),
    };
    const treeProvider = { refresh: vi.fn() };
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked } = invokeTrack(controller, treeProvider);

    await handler(pluginNode());

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not track "ModA" — already tracked');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(onTracked).not.toHaveBeenCalled();
  });
});

// ── registerRebaseCommand ──────────────────────────────────────────────────

describe('registerRebaseCommand', () => {
  function invokeRebase(controller: any) {
    const treeProvider = { refresh: vi.fn() } as any;
    const refreshMatchingPlugins = vi.fn();
    registerRebaseCommand(controller, { getPlugins: vi.fn().mockResolvedValue([]) } as any, fakeOutputChannel(), treeProvider, refreshMatchingPlugins);
    return { handler: handlers.get('modbench.pluginListTree.rebase')!, treeProvider, refreshMatchingPlugins };
  }

  it('shows the clean-rebase toast and refreshes on a landed rebase', async () => {
    const controller = {
      resolveOrigin: vi.fn().mockResolvedValue('ModA'),
      rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }),
    };
    const { handler, treeProvider, refreshMatchingPlugins } = invokeRebase(controller);

    await handler(pluginNode());

    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Rebased "ModA" onto the updated baseline.');
    expect(treeProvider.refresh).toHaveBeenCalledOnce();
    expect(refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  it('shows the ready-to-show message and refreshes nothing when the backend refuses the rebase outright', async () => {
    const controller = {
      resolveOrigin: vi.fn().mockResolvedValue('ModA'),
      rebaseOntoMain: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Could not rebase "ModA" — boom' }),
    };
    const { handler, treeProvider, refreshMatchingPlugins } = invokeRebase(controller);

    await handler(pluginNode());

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Could not rebase "ModA" — boom');
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});
