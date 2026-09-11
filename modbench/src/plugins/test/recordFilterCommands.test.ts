import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  handlers, registerCommand, showQuickPick, activeTextEditor,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
    activeTextEditor: { value: undefined as { document: Record<string, unknown> } | undefined },
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: {
    showQuickPick,
    get activeTextEditor() { return activeTextEditor.value; },
  },
  workspace: { openTextDocument: vi.fn() },
}));

vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readdirSync: vi.fn(), readFileSync: vi.fn() }));

import { registerFilterCommands, type FilterCommandDeps } from '../recordFilterCommands';
import { InMemoryMEditClient } from '../../medit/client';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  activeTextEditor.value = undefined;
});

function makeDeps(client: InMemoryMEditClient): FilterCommandDeps & {
  treeProvider: { refresh: ReturnType<typeof vi.fn> }; reporter: RecordingReporter;
} {
  return {
    scriptsPath: '/scripts',
    client,
    treeProvider: { refresh: vi.fn() } as any,
    refreshMatchingPlugins: vi.fn(),
    setFilterActive: vi.fn(),
    reporter: recordingReporter(),
  };
}

describe('setFilterFromDocument', () => {
  function invoke(client: InMemoryMEditClient) {
    const deps = makeDeps(client);
    registerFilterCommands(deps);
    return { handler: handlers.get('modbench.setFilterFromDocument')!, deps };
  }

  it('sets the filter active, refreshes the tree, and refreshes the matching-plugin set on success', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('setFilter', null);
    activeTextEditor.value = { document: { getText: () => 'SELECT form_key FROM "npc_"', isUntitled: true } };
    const { handler, deps } = invoke(client);

    await handler();

    expect(client.calls).toContainEqual({ method: 'setFilter', args: ['SELECT form_key FROM "npc_"'] });
    expect(deps.setFilterActive).toHaveBeenCalledWith(true, 'SELECT form_key FROM "npc_"', 'document');
    expect(deps.treeProvider.refresh).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // The rival: setting the filter active (or refreshing) on a failed setFilter too would leave
  // the readout claiming a filter is applied that the backend never actually accepted.
  it('reports the framed error and touches nothing else when setFilter fails', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('setFilter', 'Filter SQL must return a form_key column');
    activeTextEditor.value = { document: { getText: () => 'SELECT editor_id FROM "npc_"', isUntitled: true } };
    const { handler, deps } = invoke(client);

    await handler();

    expect(deps.reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Filter failed — Filter SQL must return a form_key column', detail: undefined },
    ]);
    expect(deps.setFilterActive).not.toHaveBeenCalled();
    expect(deps.treeProvider.refresh).not.toHaveBeenCalled();
    expect(deps.refreshMatchingPlugins).not.toHaveBeenCalled();
  });
});

describe('clearFilter', () => {
  // "Symmetric on purpose" (plugins.md): a clear refreshes exactly as a set does, or a stale
  // no-match chevron survives the filter that produced it.
  it('sets the filter inactive, refreshes the tree, and refreshes the matching-plugin set — same as a set', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('clearFilter', undefined);
    const deps = makeDeps(client);
    registerFilterCommands(deps);

    await handlers.get('modbench.clearFilter')!();

    expect(client.calls).toContainEqual({ method: 'clearFilter', args: [] });
    expect(deps.setFilterActive).toHaveBeenCalledWith(false);
    expect(deps.treeProvider.refresh).toHaveBeenCalledOnce();
    expect(deps.refreshMatchingPlugins).toHaveBeenCalledOnce();
  });
});
