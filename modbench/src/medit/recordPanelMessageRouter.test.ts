import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn();
const writeText = vi.fn();

vi.mock('vscode', () => ({
  commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
  env: { clipboard: { writeText: (v: string) => writeText(v) } },
}));

import { routeRecordPanelMessage, type RouteRecordPanelMessageDeps } from './recordPanelMessageRouter';
import { WEBVIEW_TO_EXTENSION } from './messages';

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}
const fakeReporter = { report: vi.fn() };

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return { channel: fakeChannel(), reporter: fakeReporter, ...overrides };
}

// Issue #174: the record editor webview and the extension host are different processes, bridged
// only by `postMessage` — this is the single dispatch point for every message the webview sends
// up. #410/ADR-0041: three routes survive, all reads.
describe('routeRecordPanelMessage', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    writeText.mockReset();
    fakeReporter.report.mockReset();
  });

  it('OPEN_RECORD opens the named record in the editor', async () => {
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: '000001:Fallout4.esm' }, makeDeps());

    expect(executeCommand).toHaveBeenCalledWith(
      'modbench.openEditor', { formKey: '000001:Fallout4.esm', label: '000001:Fallout4.esm' });
  });

  it('LOG forwards the message at its own level', async () => {
    const channel = fakeChannel();
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn', message: 'something' }, makeDeps({ channel }));

    expect(channel.warn).toHaveBeenCalledWith('something');
    expect(channel.debug).not.toHaveBeenCalled();
  });

  it('COPY_TO_CLIPBOARD writes through the extension host', async () => {
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value: 'copied' }, makeDeps());

    expect(writeText).toHaveBeenCalledWith('copied');
  });

  // modbench/CLAUDE.md: no silent catch. This message is dispatched fire-and-forget, so an
  // unhandled rejection would surface as nothing at all.
  it('surfaces a failed clipboard write rather than swallowing it', async () => {
    writeText.mockRejectedValue(new Error('no clipboard'));

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value: 'copied' }, makeDeps());

    expect(fakeReporter.report).toHaveBeenCalledWith(
      'error', expect.stringContaining('clipboard'), expect.stringContaining('no clipboard'));
  });

  it('an unrecognized or non-object message is a no-op', async () => {
    await routeRecordPanelMessage({ type: 'somethingElse' }, makeDeps());
    await expect(routeRecordPanelMessage('not an object', makeDeps())).resolves.toBeUndefined();
    await expect(routeRecordPanelMessage(null, makeDeps())).resolves.toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
