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

// #415: the edit path's two deps default to "applied, nobody listening" so every pre-existing case
// below keeps exercising exactly what it did; the edit tests override them explicitly.
const fakeRepository = { editRecordField: vi.fn() };
const onRecordEdited = vi.fn();

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return {
    channel: fakeChannel(), reporter: fakeReporter,
    repository: fakeRepository, onRecordEdited,
    ...overrides,
  };
}

// Issue #174: the record editor webview and the extension host are different processes, bridged
// only by `postMessage` — this is the single dispatch point for every message the webview sends
// up. #410/ADR-0041: three routes survive, all reads.
describe('routeRecordPanelMessage', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    writeText.mockReset();
    fakeReporter.report.mockReset();
    fakeRepository.editRecordField.mockReset().mockResolvedValue({ applied: true });
    onRecordEdited.mockReset();
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

// #415/ADR-0041: the one write the panel can ask for. Routed through the host rather than posted
// to the backend from the webview precisely so a refusal can become a native notification — which
// is what these cases are really pinning.
describe('routeRecordPanelMessage — EDIT_FIELD (#415)', () => {
  const editMessage = {
    type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
    formKey: '000800:Mod.esp',
    plugin: 'Mod.esp',
    origin: 'SomeMod',
    fieldPath: 'height_max',
    value: 0.75,
  };

  beforeEach(() => {
    fakeReporter.report.mockReset();
    fakeRepository.editRecordField.mockReset().mockResolvedValue({ applied: true });
    onRecordEdited.mockReset();
  });

  it('sends the edit through the single write path with its compound plugin identity', async () => {
    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(fakeRepository.editRecordField)
      .toHaveBeenCalledWith('000800:Mod.esp', 'Mod.esp', 'SomeMod', 'height_max', 0.75);
  });

  it('tells the panel to re-read once the edit has landed', async () => {
    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(onRecordEdited).toHaveBeenCalledWith('000800:Mod.esp');
    expect(fakeReporter.report).not.toHaveBeenCalled();
  });

  it('surfaces a refusal with the message that names the way out, and does not re-read', async () => {
    fakeRepository.editRecordField.mockResolvedValue({
      applied: false,
      refusal: 'PluginNotTracked',
      message: 'Mod.esp is not tracked, so it is read-only. Run "Modbench: Track\u2026" on it once to start editing.',
    });

    await routeRecordPanelMessage(editMessage, makeDeps());

    // Relayed verbatim, not re-authored: the backend's message already names the command, and
    // re-wording it here would put that text in two places with only one of them tested. Asserted
    // as the whole string rather than a substring so a partial relay (a truncation, a reformat that
    // drops the command) fails here.
    expect(fakeReporter.report).toHaveBeenCalledWith(
      'warning',
      'Mod.esp is not tracked, so it is read-only. Run "Modbench: Track\u2026" on it once to start editing.');
    expect(onRecordEdited).not.toHaveBeenCalled();
  });

  it('a refusal is a warning, not an error — the user got a clear answer with a next step', async () => {
    fakeRepository.editRecordField.mockResolvedValue({
      applied: false, refusal: 'PluginHasNoModFolder', message: 'Author a patch plugin and edit the override there.',
    });

    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(fakeReporter.report.mock.calls[0][0]).toBe('warning');
  });

  it('a transport failure is an error — nothing answered at all', async () => {
    fakeRepository.editRecordField.mockRejectedValue(new Error('ECONNREFUSED'));

    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(fakeReporter.report).toHaveBeenCalledWith('error', expect.any(String), 'ECONNREFUSED');
    expect(onRecordEdited).not.toHaveBeenCalled();
  });
});
