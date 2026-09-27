import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, createQuickPick, withProgress, executeCommand,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn<
      (items: readonly { label: string; description?: string }[], options?: unknown) =>
        Promise<{ label: string; description?: string } | undefined>
    >(),
    createQuickPick: vi.fn(),
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
  window: { showQuickPick, createQuickPick, withProgress },
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range,
  Uri: { file: uriFile },
}));

import {
  registerTrackCommand, compileAndReport, publishCompileDiagnostics, type PluginsViewProgress,
  registerSaveAndCompileCommand, registerCompileAtRefCommand,
} from '../pluginRowCommands';
import { originFiles } from '../../instanceLoader/loadOrderSnapshot';
import { InMemoryMEditClient } from '../../client';
import { PluginNode } from '../PluginsTreeProvider';
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
  return new PluginNode({ name, enabled: true }, 'ModA');
}

function clientWithOrigin(name: string, origin: string): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name, origin, inLoadOrder: true })]);
  return client;
}

type PresetItem = { label: 'Edits' | 'Everything'; description?: string };

// decompile-plugin.md's preset table, in the QuickPick items' own words (plugins.md, Pickers,
// Track: "each with a line saying what it keeps").
const EDITS_ITEM: PresetItem = { label: 'Edits', description: 'Keeps source/ and .gitignore' };
const EVERYTHING_ITEM: PresetItem = { label: 'Everything', description: 'Keeps every file except the plugin binaries' };

// Stands in for vscode.QuickPick with no VS Code host: listener registries the test triggers
// directly, matching DownloadsPanel.test.ts's own fake.
function makeFakeQuickPick() {
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    items: [] as PresetItem[],
    placeholder: undefined as string | undefined,
    activeItems: [] as PresetItem[],
    selectedItems: [] as PresetItem[],
    show: vi.fn(),
    hide: vi.fn(() => { hideListeners.forEach((cb) => cb()); }),
    dispose: vi.fn(),
    onDidAccept: (cb: () => void) => { acceptListeners.push(cb); return { dispose: () => {} }; },
    onDidHide: (cb: () => void) => { hideListeners.push(cb); return { dispose: () => {} }; },
  };
  return {
    qp,
    accept: (picked: PresetItem) => { qp.selectedItems = [picked]; acceptListeners.forEach((cb) => cb()); },
    escape: () => { hideListeners.forEach((cb) => cb()); },
  };
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
    registerTrackCommand(progress, client, reporter, onTracked, viewSelection);
    return {
      handler: present(handlers.get('modbench.plugin.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, said,
    };
  }

  // Runs `handler(...)` and settles the preset pick it opens once `createQuickPick` has been
  // called, so the QuickPick's own async wiring (onDidAccept/onDidHide) has a chance to attach.
  async function runTrackedWithPreset(
    handler: (...args: unknown[]) => unknown, picked: PresetItem | undefined, ...args: unknown[]
  ): Promise<ReturnType<typeof makeFakeQuickPick>['qp']> {
    const { qp, accept, escape } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);
    const pending = handler(...args);
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    if (picked) accept(picked); else escape();
    await pending;
    return qp;
  }

  it('tracks the right-clicked plugin alone and lands the tracked toast', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
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
    const { handler, onTracked, reporter } = invokeTrack(client);
    const nodes = [new PluginNode({ name: 'First.esp', enabled: true }, 'ModA'), new PluginNode({ name: 'Second.esp', enabled: true }, 'ModB')];

    await runTrackedWithPreset(handler, EVERYTHING_ITEM, nodes[0], nodes);

    expect(createQuickPick).toHaveBeenCalledOnce();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([
      { method: 'track', args: [[first, second], 'Everything', expect.anything()] },
    ]);
    expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not track 1 of 2 plugins.', outcome }]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 2 plugins.', detail: '"Second.esp (ModB)" (Second.esp does not round-trip.)' },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast on a refusal too would tell the user a track landed when the
  // backend refused the whole selection.
  it('reports the ready-to-show message at error when the backend refuses the whole selection', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'Could not track 1 plugin — git was not found on PATH.' });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  // The palette hands the command no row: it falls back to the view's own selection, the same
  // as every other plural gesture the entry builds.
  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [pluginNode()]);

    await runTrackedWithPreset(handler, EDITS_ITEM);

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
    expect(reporter.landings).toEqual(['Tracked "MyMod.esp".']);
  });

  it('offers Edits first and pre-selected, then Everything, each in decompile-plugin.md\'s own words for what it keeps', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { landed: [{ name: 'MyMod.esp', origin: 'ModA' }], refused: [] });
    const { handler } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, EDITS_ITEM, pluginNode());

    expect(qp.items).toEqual([EDITS_ITEM, EVERYTHING_ITEM]);
    expect(qp.activeItems).toEqual([EDITS_ITEM]);
    expect(qp.placeholder).toBe('Track "MyMod.esp"');
  });

  it('shows the preset pick and tracks nothing on Esc', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const { handler, reporter, onTracked } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, undefined, pluginNode());

    expect(qp.show).toHaveBeenCalledOnce();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('names the plugin it is about to track before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: 'First.esp', origin: 'ModA', inLoadOrder: true }),
      pluginMetadataFixture({ name: 'Second.esp', origin: 'ModB', inLoadOrder: true }),
    ]);
    client.setCommandResult('track', { landed: [{ name: 'First.esp', origin: 'ModA' }, { name: 'Second.esp', origin: 'ModB' }], refused: [] });
    const trackSpy = vi.spyOn(client, 'track');
    const { handler, said } = invokeTrack(client);
    const nodes = [new PluginNode({ name: 'First.esp', enabled: true }, 'ModA'), new PluginNode({ name: 'Second.esp', enabled: true }, 'ModB')];

    await runTrackedWithPreset(handler, EDITS_ITEM, nodes[0], nodes);

    expect(said).toContain('Tracking "ModA"…');

    const [, , options] = present(trackSpy.mock.calls[0], 'the track call');
    said.length = 0;
    present(options, 'the track options').onProgress?.({ origin: 'ModB', phase: 'Committing', pluginsDone: 2, pluginsTotal: 2 });

    expect(said).toEqual(['Tracking "ModB" — committing to git…']);
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

  // plugins.md, Compile, story 3: from the palette, a pick. An extension cannot tell whether the
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
    selected.contextValue = 'plugin enabled inMod tracked editable';
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
    untracked.contextValue = 'plugin enabled inMod untracked editable';
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
