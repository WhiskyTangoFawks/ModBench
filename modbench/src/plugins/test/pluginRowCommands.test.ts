import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, withProgress,
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
    withProgress: vi.fn((_options: unknown, work: () => Promise<unknown>) => work()),
    TreeItem, ThemeIcon, EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick, withProgress },
  TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState,
  Diagnostic: class { constructor(public range: unknown, public message: string, public severity: number) {} },
  Range: class { constructor(public a: number, public b: number, public c: number, public d: number) {} },
  DiagnosticSeverity: { Warning: 1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import {
  registerTrackCommand, registerRebaseCommand, compileAndReport, publishCompileDiagnostics,
  registerSaveAndCompileCommand, registerCompileAtRefCommand,
} from '../pluginRowCommands';
import { originFolder } from '../../modmanager/loadOrderSnapshot';
import { InMemoryMEditClient } from '../../medit/client';
import type { PluginListNode } from '../PluginsTreeProvider';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function fakeDiagnostics() {
  return { delete: vi.fn(), set: vi.fn(), [Symbol.iterator]: function* () {} } as any;
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
    const reporter = recordingReporter();
    registerTrackCommand(session, client, fakeOutputChannel(), reporter, treeProvider, onTracked);
    return { handler: handlers.get('modbench.pluginListTree.track')!, onTracked, reporter };
  }

  it('refreshes the tree and lands the tracked toast on a landed track', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { origin: 'ModA' });
    const treeProvider = { refresh: vi.fn() };
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter } = invokeTrack(client, treeProvider);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: ['ModA', 'Edits', expect.anything()] });
    expect(treeProvider.refresh).toHaveBeenCalledOnce();
    expect(reporter.landings).toEqual(['Tracked "ModA".']);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast and refreshing on a refusal too would tell the user a track
  // landed when the backend actually said "already tracked."
  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses the track', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'mEdit: Could not track "ModA" — already tracked' } as any);
    const treeProvider = { refresh: vi.fn() };
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter } = invokeTrack(client, treeProvider);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not track "ModA" — already tracked', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('reports an unresolvable origin at error and never asks what the .gitignore should hold', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter } = invokeTrack(client, { refresh: vi.fn() });

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve which mod "MyMod.esp" belongs to.', detail: undefined },
    ]);
    expect(showQuickPick).not.toHaveBeenCalled();
  });
});

// ── registerRebaseCommand ──────────────────────────────────────────────────

describe('registerRebaseCommand', () => {
  function invokeRebase(client: InMemoryMEditClient) {
    const treeProvider = { refresh: vi.fn() } as any;
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    registerRebaseCommand(client, fakeOutputChannel(), reporter, treeProvider, refreshMatchingPlugins);
    return { handler: handlers.get('modbench.pluginListTree.rebase')!, treeProvider, refreshMatchingPlugins, reporter };
  }

  it('lands the clean-rebase toast and refreshes on a landed rebase', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Clean', refusalReason: null, conflictedPaths: [] } as any);
    const { handler, treeProvider, refreshMatchingPlugins, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'rebaseOntoMain', args: ['ModA'] });
    expect(reporter.landings).toEqual(['Rebased "ModA" onto the updated baseline.']);
    expect(reporter.reports).toEqual([]);
    expect(treeProvider.refresh).toHaveBeenCalledOnce();
    expect(refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  it('reports an unresolvable origin at error and never asks the backend to rebase', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve which mod "MyMod.esp" belongs to.', detail: undefined },
    ]);
    expect(client.calls.filter((c) => c.method === 'rebaseOntoMain')).toEqual([]);
  });

  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses the rebase outright', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { refused: true, message: 'mEdit: Could not rebase "ModA" — boom' } as any);
    const { handler, treeProvider, refreshMatchingPlugins, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not rebase "ModA" — boom', detail: undefined },
    ]);
    expect(treeProvider.refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('reports a typed rebase refusal at warning, in the reason the backend gave', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Refused', refusalReason: 'the working tree is dirty', conflictedPaths: [] } as any);
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'the working tree is dirty', detail: undefined }]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports a conflicted rebase at warning, naming the gesture that resumes it', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Conflicted', refusalReason: null, conflictedPaths: [] } as any);
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'Rebasing "ModA" hit conflicts — resolve them in the opened merge editor(s), '
        + 'then run "Modbench: Rebase onto Updated Baseline" again to continue.',
      detail: undefined,
    }]);
    expect(reporter.landings).toEqual([]);
  });
});

// ── compileAndReport ───────────────────────────────────────────────────────

describe('compileAndReport', () => {
  const TARGET = { name: 'MyPatch.esp', origin: 'ModA' };

  function compile(client: InMemoryMEditClient, atRef: string | undefined, ask = scriptedDialog()) {
    const reporter = recordingReporter();
    const run = compileAndReport(client, fakeDiagnostics(), () => undefined, reporter, ask, TARGET, atRef);
    return { run, reporter, ask };
  }

  it('reports the ready-to-show message at error on a transport-level refusal (WriteRefused), never the typed-refusal wording', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' } as any);

    const { run, reporter } = compile(client, undefined);
    await run;

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not compile "MyPatch.esp" — boom', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports a failed compile at error, naming the ref it was asked for', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { succeeded: false, refusalReason: 'papyrus said no', eslContradiction: false, diagnostics: [] } as any);

    const { run, reporter } = compile(client, 'main');
    await run;

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile "MyPatch.esp" at "main" — papyrus said no', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('lands a clean compile', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { succeeded: true, refusalReason: null, eslContradiction: false, diagnostics: [] } as any);

    const { run, reporter } = compile(client, undefined);
    await run;

    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('lands a compile that produced diagnostics, counting them and pointing at the Problems panel', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', {
      succeeded: true, refusalReason: null, eslContradiction: false,
      diagnostics: [{ sourceRelativePath: 'Source/A.psc', message: 'bad' }],
    } as any);

    const { run, reporter } = compile(client, undefined);
    await run;

    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp" — 1 diagnostic(s), see Problems panel.']);
  });

  // The ESL-flag prompt is reached from here, so the dialog seam has to arrive through this call
  // or the question would be unanswerable from a test.
  it('asks the ESL-flag question through the injected dialog and retries the compile once it is accepted', async () => {
    const client = new InMemoryMEditClient();
    let attempt = 0;
    client.setCommandHandler('compile', () => Promise.resolve((attempt++ === 0
      ? { succeeded: false, refusalReason: 'exhausted the ESL range', eslContradiction: true, diagnostics: [] }
      : { succeeded: true, refusalReason: null, eslContradiction: false, diagnostics: [] }) as any));
    client.setCommandResult('editRecord', { applied: true });
    const ask = scriptedDialog('Remove ESL Flag and Compile');

    const { run, reporter } = compile(client, undefined, ask);
    await run;

    expect(ask.asked).toEqual([{
      message: '"MyPatch.esp" does not fit ESL. Remove the ESL flag and compile?\n\nexhausted the ESL range',
      detail: undefined,
      buttons: ['Remove ESL Flag and Compile'],
    }]);
    expect(client.calls).toContainEqual({
      method: 'editRecord',
      args: ['000000:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'IsSmallMaster' }], value: false }],
    });
    expect(client.calls.filter((c) => c.method === 'compile')).toHaveLength(2);
    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('reports the failure without retrying when the ESL-flag question is declined', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { succeeded: false, refusalReason: 'exhausted the ESL range', eslContradiction: true, diagnostics: [] } as any);
    const ask = scriptedDialog(undefined);

    const { run, reporter } = compile(client, undefined, ask);
    await run;

    expect(ask.asked).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'compile')).toHaveLength(1);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile "MyPatch.esp" — exhausted the ESL range', detail: undefined },
    ]);
  });
});

// ── publishCompileDiagnostics ──────────────────────────────────────────────

describe('publishCompileDiagnostics', () => {
  const compiled = (sourceRelativePath: string) => ({
    succeeded: true, diagnostics: [{ sourceRelativePath, message: 'bad' }],
  } as any);

  function collectingDiagnostics() {
    const set = new Map<string, unknown>();
    return { set: (uri: any, list: unknown) => set.set(uri.fsPath, list), delete: vi.fn(), [Symbol.iterator]: function* () {}, seen: set };
  }

  // Rival this catches: the old guess, the mods directory joined with the origin, which put an
  // overwrite-origin plugin's diagnostics under a folder that does not exist.
  it('targets the folder the value gave for the origin, overwrite included', () => {
    const diagnostics = collectingDiagnostics();
    const row = { name: 'Stray.esp', path: '/instance/overwrite/Stray.esp', origin: 'overwrite', slot: null, enabled: false, winning: true };

    publishCompileDiagnostics(diagnostics as any, originFolder([row], 'overwrite'), compiled('Source/Stray.psc'));

    expect([...diagnostics.seen.keys()]).toEqual(['/instance/overwrite/Source/Stray.psc']);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = collectingDiagnostics();

    publishCompileDiagnostics(diagnostics as any, undefined, compiled('Source/A.psc'));

    expect([...diagnostics.seen.keys()]).toEqual([]);
  });
});

// ── registerSaveAndCompileCommand ─────────────────────────────────────────

describe('registerSaveAndCompileCommand', () => {
  function invokeSaveAndCompile(client: InMemoryMEditClient) {
    const reporter = recordingReporter();
    registerSaveAndCompileCommand(
      client, { current: () => undefined }, fakeOutputChannel(), reporter, scriptedDialog(),
      fakeDiagnostics(), () => undefined);
    return { handler: handlers.get('modbench.saveAndCompile')!, reporter };
  }

  it('drives a tree-row compile through the registered command, recording the compile call and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' } as any);
    const { handler, reporter } = invokeSaveAndCompile(client);

    await handler({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not compile "MyPatch.esp" — boom', detail: undefined },
    ]);
  });

  it('reports a picked plugin with no mod folder at error and compiles nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [{ name: 'Orphan.esp', origin: undefined, inLoadOrder: true } as any]);
    showQuickPick.mockResolvedValue({ label: 'Orphan.esp', description: undefined });
    const { handler, reporter } = invokeSaveAndCompile(client);

    await handler(undefined);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: '"Orphan.esp" has no mod folder to compile into.', detail: undefined },
    ]);
    expect(client.calls.filter((c) => c.method === 'compile')).toEqual([]);
  });

  it('reports an unresolvable compile target at error and compiles nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter } = invokeSaveAndCompile(client);

    await handler({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(client.calls.filter((c) => c.method === 'compile')).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve which mod "MyPatch.esp" belongs to.', detail: undefined },
    ]);
  });
});

// ── registerCompileAtRefCommand ───────────────────────────────────────────

describe('registerCompileAtRefCommand', () => {
  function invokeCompileAtRef(client: InMemoryMEditClient, answer: string | undefined) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(answer);
    registerCompileAtRefCommand(client, fakeOutputChannel(), reporter, ask, fakeDiagnostics(), () => undefined);
    return { handler: handlers.get('modbench.pluginListTree.compileAtMain')!, reporter, ask };
  }

  it('drives a compile-at-main through the registered command once the dialog confirms, recording the compile call at "main" and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" at "main" — boom' } as any);
    const { handler, reporter, ask } = invokeCompileAtRef(client, 'Compile at main');

    await handler({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(ask.asked).toEqual([{
      message: 'Compile "MyPatch.esp" at ref "main"?',
      detail: 'This overwrites the binary with what "main" holds, without touching your edit branch. '
        + 'Your working-tree changes stay exactly where they are.',
      buttons: ['Compile at main'],
    }]);
    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', 'main'] });
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not compile "MyPatch.esp" at "main" — boom', detail: undefined },
    ]);
  });

  it('reports an unresolvable compile target at error and never asks whether to compile at main', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter, ask } = invokeCompileAtRef(client, 'Compile at main');

    await handler({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve which mod "MyPatch.esp" belongs to.', detail: undefined },
    ]);
    expect(ask.asked).toEqual([]);
    expect(client.calls.filter((c) => c.method === 'compile')).toEqual([]);
  });

  // The rival: compiling on any answer would overwrite the binary on a native Esc.
  it('compiles nothing and says nothing when the dialog is cancelled', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    const { handler, reporter, ask } = invokeCompileAtRef(client, undefined);

    await handler({ kind: 'plugin', plugin: { name: 'MyPatch.esp' } });

    expect(ask.asked).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'compile')).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });
});
