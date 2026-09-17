import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, withProgress,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
    withProgress: vi.fn((_options: unknown, work: () => Promise<unknown>) => work()),
  };
});

// Every one of this file's own vscode needs, real fakes rather than this file's own stubs.
import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick, withProgress },
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range,
  Uri: { file: uriFile },
}));

import {
  registerTrackCommand, registerRebaseCommand, compileAndReport, publishCompileDiagnostics,
  registerSaveAndCompileCommand, registerCompileAtRefCommand,
} from '../pluginRowCommands';
import { originFolder } from '../../instance/loadOrderSnapshot';
import { InMemoryMEditClient } from '../../medit/client';
import { PluginNode } from '../PluginsTreeProvider';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { pluginMetadataFixture, compileResultFixture } from '../../medit/client/test/fixtures';
import type { ExtensionSession } from '../../session';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function pluginNode(name = 'MyMod.esp'): PluginNode {
  return new PluginNode({ name, enabled: true });
}

function clientWithOrigin(name: string, origin: string): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name, origin, inLoadOrder: true })]);
  return client;
}

// ── registerTrackCommand ──────────────────────────────────────────────────

describe('registerTrackCommand', () => {
  function invokeTrack(client: InMemoryMEditClient, onTracked = vi.fn().mockResolvedValue(undefined)) {
    const session: ExtensionSession = { pluginsTreeView: undefined, pluginsNameFilter: undefined };
    const reporter = recordingReporter();
    const treeProvider = new PluginTreeProvider(client);
    const refresh = vi.spyOn(treeProvider, 'refresh').mockImplementation(() => { /* no-op */ });
    registerTrackCommand(session, client, new FakeLogOutputChannel(), reporter, treeProvider, onTracked);
    return {
      handler: present(handlers.get('modbench.pluginListTree.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, refresh,
    };
  }

  it('refreshes the tree and lands the tracked toast on a landed track', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { origin: 'ModA' });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: ['ModA', 'Edits', expect.anything()] });
    expect(refresh).toHaveBeenCalledOnce();
    expect(reporter.landings).toEqual(['Tracked "ModA".']);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast and refreshing on a refusal too would tell the user a track
  // landed when the backend actually said "already tracked."
  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses the track', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'mEdit: Could not track "ModA" — already tracked' });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not track "ModA" — already tracked', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('reports an unresolvable origin at error and never asks what the .gitignore should hold', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter } = invokeTrack(client);

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
    const treeProvider = new PluginTreeProvider(client);
    const refresh = vi.spyOn(treeProvider, 'refresh').mockImplementation(() => { /* no-op */ });
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    registerRebaseCommand(client, new FakeLogOutputChannel(), reporter, treeProvider, refreshMatchingPlugins);
    return {
      handler: present(handlers.get('modbench.pluginListTree.rebase'), 'the rebase command registerRebaseCommand registers'),
      refresh, refreshMatchingPlugins, reporter,
    };
  }

  it('lands the clean-rebase toast and refreshes on a landed rebase', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Clean', refusalReason: null, conflictedPaths: [] });
    const { handler, refresh, refreshMatchingPlugins, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'rebaseOntoMain', args: ['ModA'] });
    expect(reporter.landings).toEqual(['Rebased "ModA" onto the updated baseline.']);
    expect(reporter.reports).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
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
    client.setCommandResult('rebaseOntoMain', { refused: true, message: 'mEdit: Could not rebase "ModA" — boom' });
    const { handler, refresh, refreshMatchingPlugins, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not rebase "ModA" — boom', detail: undefined },
    ]);
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('reports a typed rebase refusal at warning, in the reason the backend gave', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Refused', refusalReason: 'the working tree is dirty', conflictedPaths: [] });
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'the working tree is dirty', detail: undefined }]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports a conflicted rebase at warning, naming the gesture that resumes it', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Conflicted', refusalReason: null, conflictedPaths: [] });
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
    const run = compileAndReport(client, new FakeDiagnosticCollection(), () => undefined, reporter, ask, TARGET, atRef);
    return { run, reporter, ask };
  }

  it('reports the ready-to-show message at error on a transport-level refusal (WriteRefused), never the typed-refusal wording', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' });

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
    client.setCommandResult('compile', compileResultFixture({ succeeded: false, refusalReason: 'papyrus said no' }));

    const { run, reporter } = compile(client, 'main');
    await run;

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile "MyPatch.esp" at "main" — papyrus said no', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('lands a clean compile', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', compileResultFixture());

    const { run, reporter } = compile(client, undefined);
    await run;

    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('lands a compile that produced diagnostics, counting them and pointing at the Problems panel', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', compileResultFixture({
      diagnostics: [{ formKey: '000000:MyPatch.esp', sourceRelativePath: 'Source/A.psc', message: 'bad' }],
    }));

    const { run, reporter } = compile(client, undefined);
    await run;

    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp" — 1 diagnostic(s), see Problems panel.']);
  });

  // The ESL-flag prompt is reached from here, so the dialog seam has to arrive through this call
  // or the question would be unanswerable from a test.
  it('asks the ESL-flag question through the injected dialog and retries the compile once it is accepted', async () => {
    const client = new InMemoryMEditClient();
    let attempt = 0;
    client.setCommandHandler('compile', () => Promise.resolve(attempt++ === 0
      ? compileResultFixture({ succeeded: false, refusalReason: 'exhausted the ESL range', eslContradiction: true })
      : compileResultFixture()));
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
    client.setCommandResult('compile', compileResultFixture({ succeeded: false, refusalReason: 'exhausted the ESL range', eslContradiction: true }));
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
  const compiled = (sourceRelativePath: string) => compileResultFixture({
    diagnostics: [{ formKey: '000000:MyPatch.esp', sourceRelativePath, message: 'bad' }],
  });

  const publishedPaths = (diagnostics: FakeDiagnosticCollection) => [...diagnostics].map(([uri]) => uri.fsPath);

  // Rival this catches: the old guess, the mods directory joined with the origin, which put an
  // overwrite-origin plugin's diagnostics under a folder that does not exist.
  it('targets the folder the value gave for the origin, overwrite included', () => {
    const diagnostics = new FakeDiagnosticCollection();
    const row = { name: 'Stray.esp', path: '/instance/overwrite/Stray.esp', origin: 'overwrite', slot: null, enabled: false, winning: true };

    publishCompileDiagnostics(diagnostics, originFolder([row], 'overwrite'), compiled('Source/Stray.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/overwrite/Source/Stray.psc']);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = new FakeDiagnosticCollection();

    publishCompileDiagnostics(diagnostics, undefined, compiled('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual([]);
  });
});

// ── registerSaveAndCompileCommand ─────────────────────────────────────────

describe('registerSaveAndCompileCommand', () => {
  function invokeSaveAndCompile(client: InMemoryMEditClient) {
    const reporter = recordingReporter();
    registerSaveAndCompileCommand(
      client, { current: () => undefined }, new FakeLogOutputChannel(), reporter, scriptedDialog(),
      new FakeDiagnosticCollection(), () => undefined);
    return {
      handler: present(handlers.get('modbench.saveAndCompile'), 'the save-and-compile command registerSaveAndCompileCommand registers'),
      reporter,
    };
  }

  it('drives a tree-row compile through the registered command, recording the compile call and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" — boom' });
    const { handler, reporter } = invokeSaveAndCompile(client);

    await handler(pluginNode('MyPatch.esp'));

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Could not compile "MyPatch.esp" — boom', detail: undefined },
    ]);
  });

  it('reports a picked plugin with no mod folder at error and compiles nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'Orphan.esp', origin: undefined, inLoadOrder: true })]);
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

    await handler(pluginNode('MyPatch.esp'));

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
    registerCompileAtRefCommand(client, new FakeLogOutputChannel(), reporter, ask, new FakeDiagnosticCollection(), () => undefined);
    return {
      handler: present(
        handlers.get('modbench.pluginListTree.compileAtMain'),
        'the compile-at-main command registerCompileAtRefCommand registers',
      ),
      reporter, ask,
    };
  }

  it('drives a compile-at-main through the registered command once the dialog confirms, recording the compile call at "main" and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'mEdit: Could not compile "MyPatch.esp" at "main" — boom' });
    const { handler, reporter, ask } = invokeCompileAtRef(client, 'Compile at main');

    await handler(pluginNode('MyPatch.esp'));

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

    await handler(pluginNode('MyPatch.esp'));

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

    await handler(pluginNode('MyPatch.esp'));

    expect(ask.asked).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'compile')).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });
});
