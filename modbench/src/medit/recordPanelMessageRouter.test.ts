import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn();
vi.mock('vscode', () => ({ commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) } }));

import { routeRecordPanelMessage, type RevealDeps } from './recordPanelMessageRouter';
import { WEBVIEW_TO_EXTENSION } from './messages';
import type { PendingTreeNode } from './PendingChangesTreeProvider';

// Issue #174: routeRecordPanelMessage is the extracted, unit-testable body of
// openRecordPanel's onDidReceiveMessage handler in extension.ts — the single dispatch point
// for every message the record editor webview posts up. Pulled out here specifically so this
// logic (both the pre-existing REVEAL_PENDING_CHANGE/OPEN_RECORD branches and the new
// PENDING_CHANGED branch) has a seam that doesn't require a real VS Code test harness.

function fakeReveal(overrides: Partial<{
  resolveChange: (id: string) => Promise<PendingTreeNode | undefined>;
  reveal: (node: PendingTreeNode, opts: unknown) => Promise<void>;
}> = {}): { reveal: RevealDeps; log: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn>; revealFn: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  const report = vi.fn();
  const refresh = vi.fn();
  const revealFn = vi.fn(overrides.reveal ?? (() => Promise.resolve()));
  const resolveChange = overrides.resolveChange ?? (() => Promise.resolve({ id: 'node' } as unknown as PendingTreeNode));
  return {
    reveal: {
      provider: { resolveChange, refresh } as unknown as RevealDeps['provider'],
      view: { reveal: revealFn } as unknown as RevealDeps['view'],
      log,
      reporter: { report },
    },
    log, report, revealFn, refresh,
  };
}

describe('routeRecordPanelMessage', () => {
  beforeEach(() => {
    executeCommand.mockClear();
  });

  it('OPEN_RECORD executes modbench.openEditor with formKey and label', async () => {
    const { reveal } = fakeReveal();
    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: '000001:Fallout4.esm' }, { reveal });

    expect(executeCommand).toHaveBeenCalledWith('modbench.openEditor', { formKey: '000001:Fallout4.esm', label: '000001:Fallout4.esm' });
  });

  it('REVEAL_PENDING_CHANGE for a resolvable change reveals it selected/focused/expanded', async () => {
    const node = { id: 'chg-1' } as unknown as PendingTreeNode;
    const { reveal, revealFn } = fakeReveal({ resolveChange: () => Promise.resolve(node) });

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE, changeId: 'chg-1' }, { reveal });

    expect(revealFn).toHaveBeenCalledWith(node, { select: true, focus: true, expand: true });
  });

  it('REVEAL_PENDING_CHANGE for a change no longer pending logs and does not reveal', async () => {
    const { reveal, revealFn, log } = fakeReveal({ resolveChange: () => Promise.resolve(undefined) });

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE, changeId: 'chg-1' }, { reveal });

    expect(revealFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chg-1'));
  });

  it('REVEAL_PENDING_CHANGE reports an error (not a throw) when resolution fails', async () => {
    const { reveal, report } = fakeReveal({ resolveChange: () => Promise.reject(new Error('boom')) });

    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE, changeId: 'chg-1' }, { reveal },
    )).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledWith('error', expect.any(String), 'boom');
  });

  it('REVEAL_PENDING_CHANGE with reveal deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE, changeId: 'chg-1' }, { reveal: undefined },
    )).resolves.toBeUndefined();
  });

  it('an unrecognized message type is a no-op', async () => {
    const { reveal, refresh, revealFn } = fakeReveal();

    await routeRecordPanelMessage({ type: 'somethingElse' }, { reveal });

    expect(executeCommand).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(revealFn).not.toHaveBeenCalled();
  });

  it('a non-object message is a no-op', async () => {
    await expect(routeRecordPanelMessage('not an object', { reveal: undefined })).resolves.toBeUndefined();
    await expect(routeRecordPanelMessage(null, { reveal: undefined })).resolves.toBeUndefined();
  });

  // Issue #174: the new branch — every successful pending-change mutation in the webview
  // posts PENDING_CHANGED, and the tree needs to refresh in response.
  it('PENDING_CHANGED refreshes the pending changes tree provider', async () => {
    const { reveal, refresh } = fakeReveal();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }, { reveal });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('PENDING_CHANGED with reveal deps undefined is a no-op, not a throw', async () => {
    await expect(routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }, { reveal: undefined })).resolves.toBeUndefined();
  });
});
