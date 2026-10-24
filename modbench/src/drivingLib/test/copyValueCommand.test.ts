import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyValueVscode, invokeCommand, register, setStatusBarMessage, writeText } from './copyValueHarness';

vi.mock('vscode', () => copyValueVscode);

import type { CopyValueAdapter } from '../copyValue';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';

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

describe('the catalog\'s one copy value id, dispatched over an ordered adapter list', () => {
  it('writes the first adapter\'s text when it applies', async () => {
    const first: CopyValueAdapter = { text: () => 'first', reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'second', reporterTag: 'second.copy' };
    await register([first, second], recordingReporter);

    await invokeCommand('clicked', ['clicked']);

    expect(writeText).toHaveBeenCalledWith('first');
  });

  it('falls through to the next adapter when one defers with undefined', async () => {
    const declines: CopyValueAdapter = { text: () => undefined, reporterTag: 'first.copy' };
    const applies: CopyValueAdapter = { text: () => 'second', reporterTag: 'second.copy' };
    await register([declines, applies], recordingReporter);

    await invokeCommand();

    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('writes nothing, says nothing and tries no further adapter when the owning adapter has empty text', async () => {
    await register([{ text: () => '', reporterTag: 'first.copy' }, { text: () => 'second', reporterTag: 'second.copy' }], recordingReporter);

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
    expect(setStatusBarMessage).not.toHaveBeenCalled();
  });

  it('writes nothing and says so when every adapter defers', async () => {
    await register(
      [{ text: () => undefined, reporterTag: 'first.copy' }, { text: () => undefined, reporterTag: 'second.copy' }],
      recordingReporter,
    );

    await invokeCommand();

    expect(writeText).not.toHaveBeenCalled();
    expect(setStatusBarMessage.mock.calls).toEqual([['Focus a list or a cell to copy its value.', 5000]]);
  });

  it('reports a failed clipboard write under the owning adapter\'s own tag', async () => {
    writeText.mockRejectedValueOnce(new Error('no clipboard'));
    const { reporterFor, reportersByTag } = reporterForRecording();
    const first: CopyValueAdapter = { text: () => undefined, reporterTag: 'first.copy' };
    const second: CopyValueAdapter = { text: () => 'text', reporterTag: 'second.copy' };
    await register([first, second], reporterFor);

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
    await register([first, second], reporterFor);

    await invokeCommand();

    expect(reportersByTag.get('second.copy')).toBeUndefined();
    expect(reportersByTag.get('first.copy')?.reports).toEqual([
      { severity: 'error', message: 'Could not copy to the clipboard.', detail: 'no clipboard' },
    ]);
  });
});
