import { describe, it, expect, vi, beforeEach } from 'vitest';

// #368 Slice 4/5: pure construction + diff wiring, no real VS Code — the resource-group/state
// shapes and the FileDecorationProvider/TextDocumentContentProvider seams are exercised against a
// minimal fake `vscode.scm`/`Uri` that mirrors the real API's observable shape (SourceControl ->
// createResourceGroup -> resourceStates), same convention PendingChangeDecorationProvider.test.ts
// already uses for FileDecorationProvider.
vi.mock('vscode', () => {
  class FakeResourceGroup {
    resourceStates: unknown[] = [];
    hideWhenEmpty?: boolean;
    constructor(public id: string, public label: string) {}
  }
  class FakeSourceControl {
    groups: FakeResourceGroup[] = [];
    disposed = false;
    constructor(public id: string, public label: string) {}
    createResourceGroup(id: string, label: string) {
      const g = new FakeResourceGroup(id, label);
      this.groups.push(g);
      return g;
    }
    dispose() { this.disposed = true; }
  }
  return {
    scm: { createSourceControl: vi.fn((id: string, label: string) => new FakeSourceControl(id, label)) },
    Uri: {
      file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
      from: (opts: { scheme: string; path: string }) =>
        ({ scheme: opts.scheme, path: opts.path, fsPath: opts.path, toString: () => `${opts.scheme}:${opts.path}` }),
    },
    EventEmitter: class {
      private handlers: ((e: unknown) => void)[] = [];
      get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
      fire(e?: unknown) { this.handlers.forEach((h) => h(e)); }
    },
    FileDecoration: class { constructor(public badge?: string, public tooltip?: string) {} },
    commands: { executeCommand: vi.fn() },
  };
});

import * as vscode from 'vscode';
import { LedgerScmProvider, LEDGER_SOURCE_CONTROL_ID, LEDGER_SOURCE_CONTROL_LABEL, LEDGER_WORKING_TREE_GROUP_ID, LEDGER_WORKING_TREE_GROUP_LABEL, LEDGER_OPEN_DIFF_COMMAND } from '../LedgerScmProvider';
import type { PluginRepository } from '../PluginRepository';
import type { LedgerStatusEntry } from '../ApiClient';

function entry(overrides: Partial<LedgerStatusEntry> = {}): LedgerStatusEntry {
  return {
    plugin: 'Vendor.esp',
    origin: 'VendorMod',
    recordType: 'npc_',
    formKey: '000800:Vendor.esp',
    changeKind: 'Modified',
    recordPath: '/mods/VendorMod/Vendor.esp.ledger/npc_/Vendor.esp/000800.yaml',
    committedText: 'FormKey: 000800:Vendor.esp\n',
    ...overrides,
  };
}

function makeRepository(entries: LedgerStatusEntry[] | (() => Promise<LedgerStatusEntry[]>)): PluginRepository {
  return {
    getLedgerStatus: vi.fn(() => (typeof entries === 'function' ? entries() : Promise.resolve(entries))),
  } as unknown as PluginRepository;
}

// vscode.scm.createSourceControl is itself a vi.fn (mocked above) — the fake it returns is
// recovered from its own mock results rather than a module-scope variable, since vi.mock factories
// are hoisted above any outer closure this file could otherwise capture.
function fakeSourceControl(): { groups: { id: string; label: string; resourceStates: unknown[]; hideWhenEmpty?: boolean }[]; disposed: boolean } {
  const create = vscode.scm.createSourceControl as unknown as ReturnType<typeof vi.fn>;
  return create.mock.results.at(-1)!.value;
}

beforeEach(() => {
  (vscode.scm.createSourceControl as unknown as ReturnType<typeof vi.fn>).mockClear();
  (vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('LedgerScmProvider construction', () => {
  it('creates one source control with one working-tree resource group, matching git\'s own naming', () => {
    new LedgerScmProvider(makeRepository([]));

    expect(vscode.scm.createSourceControl).toHaveBeenCalledWith(LEDGER_SOURCE_CONTROL_ID, LEDGER_SOURCE_CONTROL_LABEL);
    const sc = fakeSourceControl();
    expect(sc.groups).toHaveLength(1);
    expect(sc.groups[0].id).toBe(LEDGER_WORKING_TREE_GROUP_ID);
    expect(sc.groups[0].label).toBe(LEDGER_WORKING_TREE_GROUP_LABEL);
    expect(sc.groups[0].hideWhenEmpty).toBe(true);
  });

  it('dispose() disposes the underlying source control', () => {
    const provider = new LedgerScmProvider(makeRepository([]));
    provider.dispose();
    expect(fakeSourceControl().disposed).toBe(true);
  });
});

describe('LedgerScmProvider.clear', () => {
  it('empties the working-tree group synchronously, without an HTTP call', async () => {
    const repository = makeRepository([entry()]);
    const provider = new LedgerScmProvider(repository);
    await provider.refresh();
    expect(fakeSourceControl().groups[0].resourceStates).toHaveLength(1);
    (repository.getLedgerStatus as unknown as ReturnType<typeof vi.fn>).mockClear();

    provider.clear();

    expect(fakeSourceControl().groups[0].resourceStates).toEqual([]);
    expect(repository.getLedgerStatus).not.toHaveBeenCalled();
  });

  it('clears a stale decoration too — a matching file URI no longer badges after clear()', async () => {
    const e = entry();
    const provider = new LedgerScmProvider(makeRepository([e]));
    await provider.refresh();
    expect(provider.provideFileDecoration(vscode.Uri.file(e.recordPath))).toBeDefined();

    provider.clear();

    expect(provider.provideFileDecoration(vscode.Uri.file(e.recordPath))).toBeUndefined();
  });
});

describe('LedgerScmProvider.refresh', () => {
  it('produces one resource state per changed record, spanning plugins', async () => {
    const entries = [
      entry({ plugin: 'First.esp', formKey: '000800:First.esp', recordPath: '/mods/First/First.esp.ledger/npc_/First.esp/000800.yaml' }),
      entry({ plugin: 'Second.esp', formKey: '000801:Second.esp', recordPath: '/mods/Second/Second.esp.ledger/npc_/Second.esp/000801.yaml' }),
    ];
    const provider = new LedgerScmProvider(makeRepository(entries));

    await provider.refresh();

    const states = fakeSourceControl().groups[0].resourceStates as Array<{ resourceUri: { fsPath: string }; command: { command: string; arguments: unknown[] } }>;
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.resourceUri.fsPath)).toEqual([entries[0].recordPath, entries[1].recordPath]);
    expect(states[0].command).toEqual({ command: LEDGER_OPEN_DIFF_COMMAND, title: 'Open Diff', arguments: [entries[0]] });
  });

  // #368 review finding 3: SourceControlResourceState has no label field — VS Code derives the
  // row's own text from resourceUri (basename, with its containing folder as native context), so
  // the row literally reads as the ledger filename, never a constructed string. This is the test
  // asserting what the row actually presents, not what we might wish it said.
  it('presents the row as the record\'s real working-tree file — resourceUri, not a fabricated label', async () => {
    const e = entry({ recordPath: '/mods/VendorMod/Vendor.esp.ledger/npc_/Vendor.esp/000800.yaml' });
    const provider = new LedgerScmProvider(makeRepository([e]));

    await provider.refresh();

    const states = fakeSourceControl().groups[0].resourceStates as Array<{ resourceUri: { fsPath: string } }>;
    // VS Code renders this URI's basename ("000800.yaml") as the row text and its containing path
    // as context — there is no separate label field to assert against; the URI itself *is* what's
    // shown, so asserting the URI is asserting the presentation.
    expect(states[0].resourceUri.fsPath).toBe(e.recordPath);
    expect(states[0].resourceUri.fsPath.endsWith('/000800.yaml')).toBe(true);
  });

  // Since the row itself can only ever show the filename, the full identity — record type,
  // FormKey, and plugin — has to live in the one place SourceControlResourceDecorations actually
  // supports it: the tooltip (review finding 3).
  it('carries the full identity — record type, FormKey, and plugin — in the resource tooltip, alongside the change kind', async () => {
    const e = entry({ recordType: 'npc_', formKey: '000800:Vendor.esp', plugin: 'Vendor.esp', changeKind: 'Modified' });
    const provider = new LedgerScmProvider(makeRepository([e]));

    await provider.refresh();

    const states = fakeSourceControl().groups[0].resourceStates as Array<{ decorations: { tooltip: string } }>;
    const tooltip = states[0].decorations.tooltip;
    expect(tooltip).toContain('npc_');
    expect(tooltip).toContain('000800:Vendor.esp');
    expect(tooltip).toContain('Vendor.esp');
    expect(tooltip).toContain('Modified');
  });

  it('degrades to an empty group, without throwing, when the status fetch fails', async () => {
    const provider = new LedgerScmProvider(makeRepository(() => Promise.reject(new Error('backend down'))));

    await expect(provider.refresh()).resolves.toBeUndefined();

    expect(fakeSourceControl().groups[0].resourceStates).toEqual([]);
  });

  it('fires onDidChangeFileDecorations once per refresh', async () => {
    const provider = new LedgerScmProvider(makeRepository([entry()]));
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    await provider.refresh();

    expect(fired).toHaveLength(1);
  });

  // #368 review finding 7: stage/save/revert can fire in quick succession; two overlapping
  // refresh() calls' own GET /ledger/status responses can resolve out of order. Without a
  // generation guard, an older, slower response landing *after* a newer, faster one would leave
  // the panel showing stale state.
  it('discards an older refresh\'s result if a newer refresh has already resolved', async () => {
    let resolveFirst!: (entries: LedgerStatusEntry[]) => void;
    const first = new Promise<LedgerStatusEntry[]>((resolve) => { resolveFirst = resolve; });
    const repository = {
      getLedgerStatus: vi.fn()
        .mockImplementationOnce(() => first)
        .mockImplementationOnce(() => Promise.resolve([entry({ formKey: '000801:Vendor.esp' })])),
    } as unknown as PluginRepository;
    const provider = new LedgerScmProvider(repository);

    const firstRefresh = provider.refresh(); // starts, but its own fetch hasn't resolved yet
    await provider.refresh(); // starts and resolves first — this is the newer state
    resolveFirst([entry({ formKey: '000800:Vendor.esp' })]); // now let the older, slower one land
    await firstRefresh;

    const states = fakeSourceControl().groups[0].resourceStates as Array<{ command: { arguments: LedgerStatusEntry[] } }>;
    expect(states).toHaveLength(1);
    expect(states[0].command.arguments[0].formKey).toBe('000801:Vendor.esp'); // the newer result, not the older one that resolved later
  });

  // #368 review finding 4: a diff tab left open on a record's committed side must not keep
  // showing stale text after a later refresh (e.g. save-then-re-edit) changes what's committed.
  it('fires onDidChange for a record\'s committed URI when its committed text changes across a refresh', async () => {
    const repository = {
      getLedgerStatus: vi.fn()
        .mockResolvedValueOnce([entry({ committedText: 'first commit\n' })])
        .mockResolvedValueOnce([entry({ committedText: 'second commit\n' })]),
    } as unknown as PluginRepository;
    const provider = new LedgerScmProvider(repository);
    await provider.refresh();
    const fired: unknown[] = [];
    provider.onDidChange((uri) => fired.push(uri));

    await provider.refresh();

    expect(fired.length).toBeGreaterThanOrEqual(1);
    // Whichever URI(s) fired, the provider's own answer for it is the new text, not the old one —
    // proving the fired event actually corresponds to content that changed.
    const stillStale = fired.some((uri) => provider.provideTextDocumentContent(uri as never) === 'first commit\n');
    expect(stillStale).toBe(false);
  });

  it('fires onDidChange for a record\'s committed URI that drops out of a refresh entirely (reverted)', async () => {
    const e = entry();
    const repository = {
      getLedgerStatus: vi.fn()
        .mockResolvedValueOnce([e])
        .mockResolvedValueOnce([]),
    } as unknown as PluginRepository;
    const provider = new LedgerScmProvider(repository);
    await provider.refresh();
    const fired: unknown[] = [];
    provider.onDidChange((uri) => fired.push(uri));

    await provider.refresh();

    expect(fired).toHaveLength(1);
    expect(provider.provideTextDocumentContent(fired[0] as never)).toBeUndefined();
  });
});

describe('LedgerScmProvider.provideFileDecoration', () => {
  it('badges a matching real file:// URI with the change kind\'s letter', async () => {
    const e = entry({ changeKind: 'Modified' });
    const provider = new LedgerScmProvider(makeRepository([e]));
    await provider.refresh();

    const decoration = provider.provideFileDecoration(vscode.Uri.file(e.recordPath));

    expect(decoration).toEqual({ badge: 'M', tooltip: 'Modified' });
  });

  it('returns undefined for a non-file scheme, without scanning entries', async () => {
    const provider = new LedgerScmProvider(makeRepository([entry()]));
    await provider.refresh();

    expect(provider.provideFileDecoration({ scheme: 'untitled', fsPath: '/x' } as never)).toBeUndefined();
  });

  it('returns undefined for a file URI that matches no changed record', async () => {
    const provider = new LedgerScmProvider(makeRepository([entry()]));
    await provider.refresh();

    expect(provider.provideFileDecoration(vscode.Uri.file('/somewhere/else.yaml'))).toBeUndefined();
  });
});

describe('LedgerScmProvider.openDiff', () => {
  it('opens vscode.diff against the committed-scheme URI and the real working-tree file, titled for the record', async () => {
    const e = entry();
    const provider = new LedgerScmProvider(makeRepository([e]));

    await provider.openDiff(e);

    // Both URIs come from the mocked Uri.file/Uri.from, whose closures aren't reference-equal
    // across two separate calls even when structurally identical — objectContaining on the fields
    // that matter (not the function-valued toString) is what genuinely proves the right target.
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ scheme: 'modbench-ledger-committed' }),
      expect.objectContaining({ scheme: 'file', fsPath: e.recordPath }),
      `${e.recordType} ${e.formKey} (Working Tree)`,
    );
  });
});

describe('LedgerScmProvider.provideTextDocumentContent', () => {
  it('resolves the committed text for the URI openDiff hands to vscode.diff, given only what the resource state\'s own command carried', async () => {
    const e = entry({ committedText: 'FormKey: 000800:Vendor.esp\nAggression: Aggressive\n' });
    const provider = new LedgerScmProvider(makeRepository([e]));
    await provider.refresh();

    const states = fakeSourceControl().groups[0].resourceStates as Array<{ command: { arguments: LedgerStatusEntry[] } }>;
    const carried = states[0].command.arguments[0];
    await provider.openDiff(carried);
    const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    const committedUri = executeCommand.mock.calls.at(-1)![1] as vscode.Uri;

    expect(provider.provideTextDocumentContent(committedUri)).toBe(e.committedText);
  });

  it('resolves nothing for a URI naming no known record', () => {
    const provider = new LedgerScmProvider(makeRepository([]));
    const foreignUri = vscode.Uri.from({ scheme: 'modbench-ledger-committed', path: '/Unknown.esp/npc_/999999:Unknown.esp' });

    expect(provider.provideTextDocumentContent(foreignUri)).toBeUndefined();
  });
});
