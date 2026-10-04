import { describe, it, expect, vi, beforeEach } from 'vitest';

const { registerCommand, writeText } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  writeText: vi.fn<(value: string) => unknown>(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  env: { clipboard: { writeText } },
}));

import { registerCopyValueCommand, type CopyValueAdapter } from '../copyValue';
import type { Reporter } from '../../ports/reporter';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';

function invokeCommand(...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.copyValue');
  if (!call) throw new Error('modbench.copyValue was not registered');
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

const nothingToCopy = vi.fn<() => void>();

function register(
  adapters: readonly CopyValueAdapter[], reporterFor: (tag: string) => Reporter, focusedViewId?: string,
): void {
  registerCopyValueCommand(adapters, reporterFor, () => focusedViewId, nothingToCopy);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCopyValueCommand: the catalog\'s one copy value id, dispatched over an ordered adapter list', () => {
  it('registers exactly one command under the catalog id', () => {
    registerCopyValueCommand([], recordingReporter, () => undefined, nothingToCopy);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toBe('modbench.copyValue');
  });

  it('writes the first adapter\'s text when it applies', async () => {
    const first: CopyValueAdapter = { text: () => 'first', reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'second', reporterTag: 'second.copy' };
    register([first, second], recordingReporter);

    await invokeCommand('clicked', ['clicked']);

    expect(writeText).toHaveBeenCalledWith('first');
  });

  it('falls through to the next adapter when one defers with undefined', async () => {
    const declines: CopyValueAdapter = { text: () => undefined, reporterTag: 'first.copy' };
    const applies: CopyValueAdapter = { text: () => 'second', reporterTag: 'second.copy' };
    register([declines, applies], recordingReporter);

    await invokeCommand();

    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('writes nothing, and tries no further adapter, when the owning adapter has empty text', async () => {
    const owns: CopyValueAdapter = { text: () => '', reporterTag: 'first.copy' };
    const next = vi.fn(() => 'second');
    register([owns, { text: next, reporterTag: 'second.copy' }], recordingReporter);

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('writes nothing and says so when every adapter defers', async () => {
    register(
      [{ text: () => undefined, reporterTag: 'first.copy' }, { text: () => undefined, reporterTag: 'second.copy' }],
      recordingReporter,
    );

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
    expect(nothingToCopy).toHaveBeenCalledOnce();
  });

  it('says nothing when an adapter owns the invocation with empty text', async () => {
    register([{ text: () => '', reporterTag: 'first.copy' }], recordingReporter);

    await invokeCommand();

    expect(nothingToCopy).not.toHaveBeenCalled();
  });

  it('reports a failed clipboard write under the owning adapter\'s own tag', async () => {
    writeText.mockRejectedValueOnce(new Error('no clipboard'));
    const { reporterFor, reportersByTag } = reporterForRecording();
    const first: CopyValueAdapter = { text: () => undefined, reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'text', reporterTag: 'second.copy' };
    register([first, second], reporterFor);

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
    register([first, second], reporterFor);

    await invokeCommand();

    expect(reportersByTag.get('second.copy')).toBeUndefined();
    expect(reportersByTag.get('first.copy')?.reports).toEqual([
      { severity: 'error', message: 'Could not copy to the clipboard.', detail: 'no clipboard' },
    ]);
  });
});
