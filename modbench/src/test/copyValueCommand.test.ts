import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from './vscodeMock';

const { registerCommand, writeText } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  writeText: vi.fn<(value: string) => unknown>(),
}));

// `../toolbox` (this file's own module under test) wires every MO2-side view, so its own vscode
// surface is wide — `fakeVscodeModule()` covers the rest, as `toolboxPluginsNameFilter.test.ts`
// already establishes for the same module.
vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  commands: { registerCommand },
  env: { clipboard: { writeText } },
}));

import { registerCopyValueCommand, type CopyValueAdapter } from '../toolbox';
import { modsCopyValueText } from '../mods/modManagementCommands';
import { ModNode, type ModlistNode } from '../mods/ModListProvider';
import { recordingReporter, type RecordingReporter } from './surfacingDoubles';

function invokeCommand(...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.record.copyValue');
  if (!call) throw new Error('modbench.record.copyValue was not registered');
  return Promise.resolve(call[1](...args));
}

function reporterForRecording(): { reporterFor: (tag: string) => RecordingReporter; reportersByTag: Map<string, RecordingReporter> } {
  const reportersByTag = new Map<string, RecordingReporter>();
  const reporterFor = (tag: string): RecordingReporter => {
    const reporter = recordingReporter();
    reportersByTag.set(tag, reporter);
    return reporter;
  };
  return { reporterFor, reportersByTag };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCopyValueCommand: the catalog\'s one copy value id, dispatched over an ordered adapter list', () => {
  it('registers exactly one command under the catalog id', () => {
    registerCopyValueCommand([], recordingReporter);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toBe('modbench.record.copyValue');
  });

  it('writes the first adapter\'s text when it applies', async () => {
    const first: CopyValueAdapter = { text: () => 'first', reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'second', reporterTag: 'second.copy' };
    registerCopyValueCommand([first, second], recordingReporter);

    await invokeCommand('clicked', ['clicked']);

    expect(writeText).toHaveBeenCalledWith('first');
  });

  it('falls through to the next adapter when one defers with undefined', async () => {
    const declines: CopyValueAdapter = { text: () => undefined, reporterTag: 'first.copy' };
    const applies: CopyValueAdapter = { text: () => 'second', reporterTag: 'second.copy' };
    registerCopyValueCommand([declines, applies], recordingReporter);

    await invokeCommand();

    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('writes nothing, and tries no further adapter, when the owning adapter has empty text', async () => {
    const owns: CopyValueAdapter = { text: () => '', reporterTag: 'first.copy' };
    const next = vi.fn(() => 'second');
    registerCopyValueCommand([owns, { text: next, reporterTag: 'second.copy' }], recordingReporter);

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('writes nothing when every adapter defers', async () => {
    registerCopyValueCommand(
      [{ text: () => undefined, reporterTag: 'first.copy' }, { text: () => undefined, reporterTag: 'second.copy' }],
      recordingReporter,
    );

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a failed clipboard write under the owning adapter\'s own tag', async () => {
    writeText.mockRejectedValueOnce(new Error('no clipboard'));
    const { reporterFor, reportersByTag } = reporterForRecording();
    const first: CopyValueAdapter = { text: () => undefined, reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'text', reporterTag: 'second.copy' };
    registerCopyValueCommand([first, second], reporterFor);

    await invokeCommand();

    expect(reportersByTag.get('first.copy')).toBeUndefined();
    expect(reportersByTag.get('second.copy')?.reports).toEqual([
      { severity: 'error', message: 'Could not copy to the clipboard.', detail: 'no clipboard' },
    ]);
  });

  it('reports under the first adapter\'s own tag when it is the one that owns the invocation', async () => {
    writeText.mockRejectedValueOnce(new Error('no clipboard'));
    const { reporterFor, reportersByTag } = reporterForRecording();
    const first: CopyValueAdapter = { text: () => 'text', reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'unreachable', reporterTag: 'second.copy' };
    registerCopyValueCommand([first, second], reporterFor);

    await invokeCommand();

    expect(reportersByTag.get('second.copy')).toBeUndefined();
    expect(reportersByTag.get('first.copy')?.reports).toEqual([
      { severity: 'error', message: 'Could not copy to the clipboard.', detail: 'no clipboard' },
    ]);
  });
});

describe('registerCopyValueCommand with Mods\' real adapter', () => {
  it('copies a right-clicked mod\'s own name through modsCopyValueText, unstubbed', async () => {
    const viewSelection = (): ModlistNode[] => [];
    const modsAdapter: CopyValueAdapter = { text: modsCopyValueText(viewSelection), reporterTag: 'mod.copyValue' };
    const referencedByStub: CopyValueAdapter = { text: () => undefined, reporterTag: 'referencedByTree.copy' };
    registerCopyValueCommand([modsAdapter, referencedByStub], recordingReporter);
    const clicked = new ModNode({ kind: 'mod', name: 'Alpha', enabled: true });

    await invokeCommand(clicked, [clicked]);

    expect(writeText).toHaveBeenCalledWith('Alpha');
  });

  // Referenced By's own Ctrl+C invokes with no arguments (package.json). Mods has no key of its
  // own here, so a Mods selection sitting in the view must never intercept that invocation.
  it('a no-argument invocation still copies Referenced By\'s selection, even with a Mods row selected', async () => {
    const viewSelection = (): ModlistNode[] => [new ModNode({ kind: 'mod', name: 'Alpha', enabled: true })];
    const modsAdapter: CopyValueAdapter = { text: modsCopyValueText(viewSelection), reporterTag: 'mod.copyValue' };
    const referencedByStub: CopyValueAdapter = { text: () => 'NPC_ / TestNPC', reporterTag: 'referencedByTree.copy' };
    registerCopyValueCommand([modsAdapter, referencedByStub], recordingReporter);

    await invokeCommand();

    expect(writeText).toHaveBeenCalledWith('NPC_ / TestNPC');
  });
});
