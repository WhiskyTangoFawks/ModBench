import { describe, it, expect, vi } from 'vitest';

// pendingChangeRowUri.ts (imported below via recordRowUri/pluginRowUri) itself calls
// vscode.Uri.from — this mock covers that too, so the tests exercise the real URI builders (not
// duck-typed identity objects), proving the whole pipeline round-trips end to end.
vi.mock('vscode', () => ({
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach((h) => h(e)); }
  },
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) => ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import * as vscode from 'vscode';
import { PendingChangeDecorationProvider } from './PendingChangeDecorationProvider';
import { recordRowUri, pluginRowUri } from './pendingChangeRowUri';

function change(overrides: Partial<{ id: string; formKey: string; plugin: string; changeType: string }> = {}) {
  return { id: 'c1', formKey: '001234:MyPatch.esp', plugin: 'MyPatch.esp', changeType: 'field_edit', ...overrides };
}

function makeClient(changes: ReturnType<typeof change>[] | undefined, ok = true) {
  return {
    GET: vi.fn().mockResolvedValue(ok ? { data: changes, response: { ok: true } } : { data: undefined, response: { ok: false, status: 500 } }),
  } as any;
}

describe('PendingChangeDecorationProvider', () => {
  it('provideFileDecoration returns undefined for a foreign-scheme URI, without ever fetching', () => {
    const client = makeClient([]);
    const provider = new PendingChangeDecorationProvider(client);

    const result = provider.provideFileDecoration({ scheme: 'file', path: '/x', query: '' } as never);

    expect(result).toBeUndefined();
    expect(client.GET).not.toHaveBeenCalled();
  });

  it('decorates a record row modified after refresh() finds a matching field_edit change', async () => {
    const client = makeClient([change({ changeType: 'field_edit' })]);
    const provider = new PendingChangeDecorationProvider(client);

    await provider.refresh();
    const decoration = provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'));

    expect(decoration?.badge).toBe('M');
    expect(decoration?.color).toEqual(new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
  });

  it('decorates a record row added after refresh() finds a matching create change', async () => {
    const client = makeClient([change({ changeType: 'create' })]);
    const provider = new PendingChangeDecorationProvider(client);

    await provider.refresh();
    const decoration = provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'));

    expect(decoration?.badge).toBe('A');
    expect(decoration?.color).toEqual(new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
  });

  it('clears the decoration once a second refresh() reports the change gone (reverted/saved)', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);
    await provider.refresh();
    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();

    client.GET.mockResolvedValue({ data: [], response: { ok: true } });
    await provider.refresh();

    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeUndefined();
  });

  // #331 review: exitToLoadout() calls this, never refresh() — a live re-fetch right after
  // backendManager.stop() would race the still-terminating backend process.
  it('clear() empties the decoration set synchronously, without an HTTP call', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);
    await provider.refresh();
    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();
    client.GET.mockClear();

    provider.clear();

    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeUndefined();
    expect(client.GET).not.toHaveBeenCalled();
  });

  it('clear() fires onDidChangeFileDecorations', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);
    await provider.refresh();
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    provider.clear();

    expect(fired).toHaveLength(1);
  });

  it('decorates a plugin row when a contained record has a pending change', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);

    await provider.refresh();
    const decoration = provider.provideFileDecoration(pluginRowUri('MyPatch.esp'));

    expect(decoration?.badge).toBe('M');
  });

  // #334 AC: "No notification/toast is raised for either failure; each is logged." No toast is
  // ever raised by this provider (nothing here calls vscode.window.*), so the log call is the
  // only observable proof the failure was noticed.
  it('degrades to no decoration, without throwing, and logs the failure, when the /changes fetch fails with no prior state', async () => {
    const client = makeClient(undefined, false);
    const log = vi.fn();
    const provider = new PendingChangeDecorationProvider(client, log);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  // #334 decision 1: stale-but-flagged beats confidently-empty — a failed refresh must not
  // read as "nothing staged" when there was staged work a moment ago.
  it('retains the last-known decorations when a subsequent /changes fetch returns non-OK', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);
    await provider.refresh();
    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();

    client.GET.mockResolvedValue({ data: undefined, response: { ok: false, status: 500 } });
    await provider.refresh();

    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();
  });

  it('retains the last-known decorations when a subsequent /changes fetch throws', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);
    await provider.refresh();
    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();

    client.GET.mockRejectedValue(new Error('network down'));
    await expect(provider.refresh()).resolves.toBeUndefined();

    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();
  });

  // #334 review (Standards axis): retention is only safe where `this.changes` is a trustworthy
  // baseline from the *current* session. Session entry (extension.ts's makeEnterEditing) has none
  // — `this.changes` may still hold a previous session's entries — so a failed entry fetch must
  // clear rather than retain, or a stale decoration leaks across the session boundary.
  it('clears, not retains, a prior session\'s decorations when refresh(false) — no trustworthy baseline — fails', async () => {
    const client = makeClient([change()]);
    const provider = new PendingChangeDecorationProvider(client);
    await provider.refresh();
    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeDefined();

    client.GET.mockResolvedValue({ data: undefined, response: { ok: false, status: 500 } });
    await provider.refresh(false);

    expect(provider.provideFileDecoration(recordRowUri('MyPatch.esp', '001234:MyPatch.esp'))).toBeUndefined();
  });

  it('fires onDidChangeFileDecorations once per refresh() call', async () => {
    const client = makeClient([]);
    const provider = new PendingChangeDecorationProvider(client);
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    await provider.refresh();

    expect(fired).toHaveLength(1);
  });
});
