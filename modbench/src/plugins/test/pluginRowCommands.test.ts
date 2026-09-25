import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, withProgress, executeCommand,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
    withProgress: vi.fn((_options: unknown, work: () => Promise<unknown>) => work()),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };
});

// Every one of this file's own vscode needs, real fakes rather than this file's own stubs.
import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showQuickPick, withProgress },
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range,
  Uri: { file: uriFile },
}));

import {
  registerTrackCommand, registerRebaseCommand, compileAndReport, publishCompileDiagnostics, type PluginsViewProgress,
  registerSaveAndCompileCommand, registerCompileAtRefCommand, rebaseInProgressIn, watchRepositoryStates,
  type MinimalRepository,
} from '../pluginRowCommands';
import { pluginAddressKey } from '../trackedRepositories';
import { originFiles } from '../../instanceLoader/loadOrderSnapshot';
import { InMemoryMEditClient } from '../../client';
import { PluginNode } from '../PluginsTreeProvider';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { pluginMetadataFixture, compileResultFixture } from '../../client/test/fixtures';
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
  function invokeTrack(
    client: InMemoryMEditClient, onTracked = vi.fn().mockResolvedValue(undefined),
    viewSelection: () => readonly PluginNode[] = () => [],
  ) {
    const said: (string | undefined)[] = [];
    const progress: PluginsViewProgress = { while: (work) => work(), say: (message) => said.push(message) };
    const reporter = recordingReporter();
    const treeProvider = new PluginTreeProvider(client);
    const refresh = vi.spyOn(treeProvider, 'refresh').mockImplementation(() => { /* no-op */ });
    registerTrackCommand(progress, client, new FakeLogOutputChannel(), reporter, treeProvider, onTracked, viewSelection);
    return {
      handler: present(handlers.get('modbench.plugin.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, refresh, said,
    };
  }

  it('tracks the right-clicked plugin alone, refreshes the tree and lands the tracked toast', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
    expect(refresh).toHaveBeenCalledOnce();
    expect(reporter.landings).toEqual(['Tracked "MyMod.esp".']);
    expect(reporter.reports).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // commands.md, "A selection is one gesture": one call with the whole selection, asked once, and
  // one notification naming each refused plugin and why.
  it('tracks the whole selection in one call, asks the preset once, and reports each refused plugin once while the rest land', async () => {
    const client = new InMemoryMEditClient();
    const first = { name: 'First.esp', origin: 'ModA' };
    const second = { name: 'Second.esp', origin: 'ModB' };
    const outcome = { landed: [first], refused: [{ item: second, reason: 'Second.esp does not round-trip.' }] };
    client.setCommandResult('track', outcome);
    showQuickPick.mockResolvedValue({ label: 'Everything' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);
    const nodes = [new PluginNode({ name: 'First.esp', enabled: true }, 'ModA'), new PluginNode({ name: 'Second.esp', enabled: true }, 'ModB')];

    await handler(nodes[0], nodes);

    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([
      { method: 'track', args: [[first, second], 'Everything', expect.anything()] },
    ]);
    expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not track 1 of 2 plugins.', outcome }]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 2 plugins.', detail: '"Second.esp (ModB)" (Second.esp does not round-trip.)' },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast and refreshing on a refusal too would tell the user a track
  // landed when the backend refused the whole selection.
  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses the whole selection', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'Could not track 1 plugin — git was not found on PATH.' });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('refuses a plugin whose mod cannot be resolved, naming it, and never asks what the .gitignore should hold', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter } = invokeTrack(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 1 plugins.', detail: '"MyMod.esp" (its mod could not be resolved)' },
    ]);
    // ADR-0012: the row's own identity, with no origin invented for it.
    expect(reporter.selectionOutcomeCalls.map((call) => call.outcome.refused.map((r) => r.item))).toEqual([[{ name: 'MyMod.esp' }]]);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([]);
  });

  // The palette hands the command no row: it falls back to the view's own selection, the same
  // as every other plural gesture the entry builds.
  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, reporter } = invokeTrack(client, undefined, () => [pluginNode()]);

    await handler();

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
    expect(reporter.landings).toEqual(['Tracked "MyMod.esp".']);
  });
});

// ── registerRebaseCommand ──────────────────────────────────────────────────

describe('registerRebaseCommand', () => {
  function invokeRebase(client: InMemoryMEditClient, viewSelection: readonly PluginNode[] = []) {
    const treeProvider = new PluginTreeProvider(client);
    const refresh = vi.spyOn(treeProvider, 'refresh').mockImplementation(() => { /* no-op */ });
    const refreshMatchingPlugins = vi.fn();
    const reporter = recordingReporter();
    const modA = { name: 'MyMod.esp', path: '/instance/mods/ModA/MyMod.esp', origin: 'ModA', slot: 0, enabled: true, winning: true };
    registerRebaseCommand(
      client, new FakeLogOutputChannel(), reporter, treeProvider, refreshMatchingPlugins, (origin) => originFiles([modA], origin),
      () => viewSelection);
    return {
      handler: present(handlers.get('modbench.mod.rebaseEditBranch'), 'the rebase command registerRebaseCommand registers'),
      refresh, refreshMatchingPlugins, reporter,
    };
  }

  it('reports nothing on a clean rebase, but still refreshes', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Clean', refusalReason: null, conflictedPaths: [] });
    const { handler, refresh, refreshMatchingPlugins, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'rebaseOntoMain', args: ['ModA'] });
    expect(reporter.landings).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refreshMatchingPlugins).toHaveBeenCalledOnce();
  });

  // commands.md, Where: the palette hands the gesture no row, so it takes the one selected plugin.
  it('rebases the one selected plugin\'s mod from the palette', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('rebaseOntoMain', { outcome: 'Clean', refusalReason: null, conflictedPaths: [] });
    const { handler } = invokeRebase(client, [pluginNode()]);

    await handler();

    expect(client.calls).toContainEqual({ method: 'rebaseOntoMain', args: ['ModA'] });
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
    client.setCommandResult('rebaseOntoMain', { refused: true, message: 'Could not rebase "ModA" — boom' });
    const { handler, refresh, refreshMatchingPlugins, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rebase "ModA" — boom', detail: undefined },
    ]);
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshMatchingPlugins).not.toHaveBeenCalled();
  });

  it('reports a typed rebase refusal at warning, naming the dirty paths the backend gave', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const refusalReason = 'Cannot rebase: uncommitted changes in source/Scripts/Foo.psc. '
      + 'Commit, stash, or discard them first, then try again.';
    client.setCommandResult('rebaseOntoMain', { outcome: 'Refused', refusalReason, conflictedPaths: [] });
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([{ severity: 'warning', message: refusalReason, detail: undefined }]);
    expect(reporter.landings).toEqual([]);
  });

  it('opens the native merge editor for every conflicted path, and reports nothing when the backend gave no reason', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult(
      'rebaseOntoMain',
      { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/Scripts/Foo.psc', 'source/Scripts/Bar.psc'] },
    );
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(executeCommand).toHaveBeenCalledWith('git.openMergeEditor', expect.objectContaining({ fsPath: '/instance/mods/ModA/source/Scripts/Foo.psc' }));
    expect(executeCommand).toHaveBeenCalledWith('git.openMergeEditor', expect.objectContaining({ fsPath: '/instance/mods/ModA/source/Scripts/Bar.psc' }));
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  // SourceRepository.cs's autostash case: git kept the change in the stash list rather than
  // losing it, and the reason names the recovery — the merge editor alone does not say that.
  it('reports the reason a conflicted rebase carries, once the merge editor is open', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const refusalReason = 'The rebase replayed cleanly, but re-applying its autostashed tracked-file changes '
      + 'conflicted. Nothing was lost — they are kept in `git stash list` — resolve the conflict markers, '
      + 'stage them, then run `git stash drop`.';
    client.setCommandResult(
      'rebaseOntoMain', { outcome: 'Conflicted', refusalReason, conflictedPaths: ['source/Scripts/Foo.psc'] },
    );
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(executeCommand).toHaveBeenCalledWith('git.openMergeEditor', expect.objectContaining({ fsPath: '/instance/mods/ModA/source/Scripts/Foo.psc' }));
    expect(reporter.reports).toEqual([{ severity: 'warning', message: refusalReason, detail: undefined }]);
    expect(reporter.landings).toEqual([]);
  });

  // The rival: falling straight back to `vscode.open` on every path, without trying the real
  // merge editor first, would leave conflict markers in a plain text editor with no explanation.
  it('falls back to a plain editor and reports why, when the Git extension cannot open the merge editor', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult(
      'rebaseOntoMain', { outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/Scripts/Foo.psc'] },
    );
    executeCommand.mockImplementation((command: string) => (
      command === 'git.openMergeEditor' ? Promise.reject(new Error('command not found')) : Promise.resolve(undefined)
    ));
    const { handler, reporter } = invokeRebase(client);

    await handler(pluginNode());

    expect(executeCommand).toHaveBeenCalledWith('vscode.open', expect.objectContaining({ fsPath: '/instance/mods/ModA/source/Scripts/Foo.psc' }));
    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'Could not open the merge editor for "source/Scripts/Foo.psc" — opened it as a text editor instead.',
      detail: 'command not found',
    }]);
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
    client.setCommandResult('compile', { refused: true, message: 'Could not compile "MyPatch.esp" — boom' });

    const { run, reporter } = compile(client, undefined);
    await run;

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile "MyPatch.esp" — boom', detail: undefined },
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

    publishCompileDiagnostics(diagnostics, originFiles([row], 'overwrite'), compiled('Source/Stray.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/overwrite/Source/Stray.psc']);
  });

  it("replaces the entries the origin's folder holds, and leaves every other folder's", () => {
    const diagnostics = new FakeDiagnosticCollection();
    const rows = [
      { name: 'A.esp', path: '/instance/mods/ModA/A.esp', origin: 'ModA', slot: 0, enabled: true, winning: true },
      { name: 'B.esp', path: '/instance/mods/ModB/B.esp', origin: 'ModB', slot: 1, enabled: true, winning: true },
    ];
    publishCompileDiagnostics(diagnostics, originFiles(rows, 'ModA'), compiled('Source/Old.psc'));
    publishCompileDiagnostics(diagnostics, originFiles(rows, 'ModB'), compiled('Source/Other.psc'));

    publishCompileDiagnostics(diagnostics, originFiles(rows, 'ModA'), compiled('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/mods/ModB/Source/Other.psc', '/instance/mods/ModA/Source/A.psc']);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = new FakeDiagnosticCollection();

    publishCompileDiagnostics(diagnostics, undefined, compiled('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual([]);
  });
});

// ── registerSaveAndCompileCommand ─────────────────────────────────────────

describe('registerSaveAndCompileCommand', () => {
  function invokeSaveAndCompile(client: InMemoryMEditClient, viewSelection: readonly PluginNode[] = []) {
    const reporter = recordingReporter();
    registerSaveAndCompileCommand(
      client, new FakeLogOutputChannel(), reporter, scriptedDialog(),
      new FakeDiagnosticCollection(), () => undefined, () => viewSelection);
    return {
      handler: present(handlers.get('modbench.saveAndCompile'), 'the save-and-compile command registerSaveAndCompileCommand registers'),
      reporter,
    };
  }

  it('drives a tree-row compile through the registered command, recording the compile call and surfacing the refusal', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    client.setCommandResult('compile', { refused: true, message: 'Could not compile "MyPatch.esp" — boom' });
    const { handler, reporter } = invokeSaveAndCompile(client);

    await handler(pluginNode('MyPatch.esp'));

    expect(client.calls).toContainEqual({ method: 'compile', args: ['MyPatch.esp', 'ModA', undefined] });
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile "MyPatch.esp" — boom', detail: undefined },
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

  // plugins.md, Compile, story 5: from the palette, a pick. An extension cannot tell whether the
  // Plugins view has focus, so the selection is never compiled unasked; a selected compilable
  // plugin leads the pick.
  it('asks from the palette, leading the pick with the one selected compilable plugin', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: 'Other.esp', origin: 'ModB', isTracked: true, isImmutable: false }),
      pluginMetadataFixture({ name: 'MyPatch.esp', origin: 'ModA', isTracked: true, isImmutable: false }),
    ]);
    showQuickPick.mockResolvedValue(undefined);
    const selected = new PluginNode({ name: 'MyPatch.esp', enabled: true }, 'ModA');
    selected.contextValue = 'plugin rebasable compilable';
    const { handler } = invokeSaveAndCompile(client, [selected]);

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'MyPatch.esp', description: 'ModA' }, { label: 'Other.esp', description: 'ModB' }],
      { placeHolder: 'Compile which plugin?' });
    expect(client.calls.filter((c) => c.method === 'compile')).toEqual([]);
  });

  it('asks, from the palette with no compilable plugin selected, which of the tracked, editable plugins to compile', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: 'Editable.esp', origin: 'ModA', isTracked: true, isImmutable: false }),
      pluginMetadataFixture({ name: 'Untracked.esp', origin: 'ModB', isTracked: false, isImmutable: false }),
      pluginMetadataFixture({ name: 'ReadOnly.esp', origin: 'ModC', isTracked: true, isImmutable: true }),
    ]);
    showQuickPick.mockResolvedValue(undefined);
    const untracked = pluginNode('Untracked.esp');
    untracked.contextValue = 'plugin untrackedInMod';
    const { handler } = invokeSaveAndCompile(client, [untracked]);

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith([{ label: 'Editable.esp', description: 'ModA' }], { placeHolder: 'Compile which plugin?' });
  });

  // editor.md, Menus and keys: compile on a column header, whose context names the column's plugin.
  it('compiles the plugin a record tab\'s column header names, at its own origin', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', compileResultFixture());
    const { handler } = invokeSaveAndCompile(client, [pluginNode('Selected.esp')]);

    await handler({
      webviewSection: 'recordHeader', formKey: '000801:Other.esp', plugin: 'Other.esp', origin: 'ModB',
      compilable: true, preventDefaultContextMenuItems: true,
    });

    expect(client.calls.filter((c) => c.method === 'compile').map((c) => c.args.slice(0, 2))).toEqual([['Other.esp', 'ModB']]);
  });

  it('asks which plugin to compile in the catalog\'s own verb, when no row is in hand', async () => {
    const client = clientWithOrigin('MyPatch.esp', 'ModA');
    showQuickPick.mockResolvedValue(undefined);
    const { handler } = invokeSaveAndCompile(client);

    await handler(undefined);

    expect(showQuickPick).toHaveBeenCalledWith(expect.anything(), { placeHolder: 'Compile which plugin?' });
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
    client.setCommandResult('compile', { refused: true, message: 'Could not compile "MyPatch.esp" at "main" — boom' });
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
      { severity: 'error', message: 'Could not compile "MyPatch.esp" at "main" — boom', detail: undefined },
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

// plugins.md, Menus and keys, story 6: rebase edit branch is offered only while no rebase is in
// progress, which the mod's repository in vscode.git says, and says again as it changes.
describe('a tracked mod\'s rebase in progress', () => {
  function fakeRepository(rebasing: boolean) {
    const listeners: (() => void)[] = [];
    const repository: MinimalRepository = {
      status: () => Promise.resolve(),
      state: {
        rebaseCommit: rebasing ? { hash: 'abc' } : undefined,
        onDidChange: (listener: () => void) => {
          listeners.push(listener);
          return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
        },
      },
    };
    return { repository, change: () => { for (const listener of [...listeners]) listener(); } };
  }

  it('is the plugin\'s own mod repository\'s answer, and none with no repository', () => {
    const repos = new Map([
      [pluginAddressKey('A.esp', 'ModA'), fakeRepository(true).repository],
      [pluginAddressKey('B.esp', 'ModB'), fakeRepository(false).repository],
    ]);

    expect(rebaseInProgressIn(repos, 'a.ESP', 'moda')).toBe(true);
    expect(rebaseInProgressIn(repos, 'B.esp', 'ModB')).toBe(false);
    expect(rebaseInProgressIn(repos, 'C.esp', 'ModC')).toBe(false);
    expect(rebaseInProgressIn(undefined, 'A.esp', 'ModA')).toBe(false);
  });

  it('hears each repository\'s state change until disposed', () => {
    const a = fakeRepository(false);
    const b = fakeRepository(false);
    const heard = vi.fn();
    const watch = watchRepositoryStates(new Map([['a', a.repository], ['b', b.repository]]), heard);

    a.change();
    b.change();
    watch.dispose();
    a.change();

    expect(heard).toHaveBeenCalledTimes(2);
  });
});
