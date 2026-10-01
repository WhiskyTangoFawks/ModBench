import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn<(...args: unknown[]) => unknown>();
const writeText = vi.fn<(...args: unknown[]) => unknown>();
const createQuickPick = vi.fn<(...args: unknown[]) => unknown>();
const showQuickPick = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
  commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
  env: { clipboard: { writeText: (v: string) => writeText(v) } },
  window: {
    createQuickPick: (...args: unknown[]) => createQuickPick(...args),
    showQuickPick: (...args: unknown[]) => showQuickPick(...args),
  },
}));

import {
  routeRecordPanelMessage, type RouteRecordPanelMessageDeps,
} from '../recordPanelMessageRouter';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import type { CompareResult } from '../../client';
import { InMemoryMEditClient } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';

beforeEach(() => { createQuickPick.mockClear(); showQuickPick.mockClear(); });

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

let meditClient: InMemoryMEditClient;

beforeEach(() => { meditClient = new InMemoryMEditClient(); });

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return {
    channel: fakeChannel(),
    reporter: { insideDialog: vi.fn() },
    meditClient,
    // Undefined by default: a message arriving with no deps wired is a no-op, not a crash.
    formKeyPicker: undefined,
    focusCell: vi.fn(),
    reply: vi.fn(),
    setTitle: vi.fn(),
    conflictsComputed: () => true,
    loadFailures: () => [],
    ...overrides,
  };
}

// The record editor webview and the extension host are different processes, bridged
// only by `postMessage` — this is the single dispatch point for every message the webview sends
// up.
describe('routeRecordPanelMessage', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    writeText.mockReset();
    createQuickPick.mockReset();
  });

  it('opens nothing for a click on a reference: go to record is the menu\'s', async () => {
    await routeRecordPanelMessage({ type: 'openRecord', formKey: '000001:Fallout4.esm' }, makeDeps());

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('LOG forwards the message at its own level', async () => {
    const channel = fakeChannel();
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn', message: 'something' }, makeDeps({ channel }));

    expect(channel.warn).toHaveBeenCalledWith('something');
    expect(channel.debug).not.toHaveBeenCalled();
  });

  it('an unrecognized or non-object message is a no-op', async () => {
    await routeRecordPanelMessage({ type: 'somethingElse' }, makeDeps());
    await expect(routeRecordPanelMessage('not an object', makeDeps())).resolves.toBeUndefined();
    await expect(routeRecordPanelMessage(null, makeDeps())).resolves.toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  // Correctly discriminated (a real EDIT_FIELD), but formKey is the wrong type — parseWebviewToExtension's
  // required-field check, not its discriminant switch.
  it('a correctly-discriminated message with a malformed payload is also a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: 123, plugin: 'Mod.esp', origin: 'SomeMod', envelope: { op: 'set', path: [] } },
      makeDeps(),
    )).resolves.toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
  });
});

// commands.md, Entry points are not gestures: a grid edit is an entry point to the command the
// palette fires too, so the router writes nothing itself.
describe('routeRecordPanelMessage — EDIT_FIELD', () => {
  const envelope = {
    op: 'set' as const,
    path: [{ kind: 'member' as const, name: 'Height' }],
    value: 0.75,
  };
  const editMessage = {
    type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
    formKey: '000800:Mod.esp',
    plugin: 'Mod.esp',
    origin: 'SomeMod',
    envelope,
  };

  beforeEach(() => { executeCommand.mockReset(); });

  it('fires modbench.record.editField with the column\'s (origin, filename), its panel and the envelope', async () => {
    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.editField', {
      formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'SomeMod',
    }, envelope);
    expect(meditClient.calls).toEqual([]);
  });
});

describe('routeRecordPanelMessage — ADD_ELEMENT', () => {
  const context = {
    webviewSection: 'arrayElement', formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'SomeMod',
    path: [{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 1 }],
    canMoveUp: true, canMoveDown: true, preventDefaultContextMenuItems: true,
  };

  beforeEach(() => { executeCommand.mockReset(); });

  it('hands addElement the value a drop supplies as its Option', async () => {
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.ADD_ELEMENT, context, value: { Keyword: '000800:Mod.esp' } },
      makeDeps());

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.addElement', context, { Keyword: '000800:Mod.esp' });
  });
});

describe('routeRecordPanelMessage — OPEN_FORM_KEY_PICKER', () => {
  const message = { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: [] };

  it('with no picker deps is a no-op', async () => {
    await routeRecordPanelMessage(message, makeDeps());

    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('replies to the asking panel with the dismissed picker\'s null, correlated by requestId', async () => {
    const hideListeners: Array<() => void> = [];
    createQuickPick.mockReturnValue({
      show: () => { hideListeners.forEach(cb => cb()); }, dispose: vi.fn(),
      onDidChangeValue: vi.fn(), onDidAccept: vi.fn(), onDidHide: (cb: () => void) => { hideListeners.push(cb); },
    });
    const reply = vi.fn();
    const formKeyPicker = { meditClient, reporter: { insideDialog: vi.fn() }, reply };

    await routeRecordPanelMessage(message, makeDeps({ formKeyPicker }));

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: 'r1', formKey: null });
  });
});

describe('routeRecordPanelMessage — the focused cell', () => {
  it('hands the panel\'s focused cell to its own tracker, and null as no cell', async () => {
    const focusCell = vi.fn();
    const context = { webviewSection: 'stringValue', formKey: '000001:A.esp' };

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context, entered: true }, makeDeps({ focusCell }));
    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null, entered: false }, makeDeps({ focusCell }));

    expect(focusCell.mock.calls).toEqual([[context, true], [undefined, false]]);
  });
});

// ADR-0002 invariant 2: RecordPanelClient's own read, asked of the mEdit client through the host
// rather than fetched by the webview itself.
describe('routeRecordPanelMessage — REQUEST_RECORD_LOAD', () => {
  const compare: CompareResult = { overrides: [], diffs: [], conflictAll: 'OnlyOne', recordTypeName: 'Activator' };
  const plugins = [pluginMetadataFixture({ name: 'A.esp', isImmutable: true })];
  const loadMessage = { type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp' };

  it('answers with the comparison, the plugin list and the settled conflictsComputed', async () => {
    meditClient.setQueryAnswer('getComparison', compare);
    meditClient.setQueryAnswer('getPlugins', plugins);
    const reply = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply, conflictsComputed: () => true }));

    expect(reply).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true, loadFailures: [],
    });
  });

  it('answers with the plugins mEdit cannot read', async () => {
    meditClient.setQueryAnswer('getComparison', compare);
    meditClient.setQueryAnswer('getPlugins', plugins);
    const reply = vi.fn();
    const failure = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply, loadFailures: () => [failure] }));

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, loadFailures: [failure] }));
  });

  it('answers a record held by no active plugin as a null comparison, not a failure', async () => {
    meditClient.setQueryAnswer('getComparison', null);
    meditClient.setQueryAnswer('getPlugins', plugins);
    const reply = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply, conflictsComputed: () => true }));

    expect(reply).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: null, plugins, conflictsComputed: true, loadFailures: [],
    });
  });

  it('titles the tab from the record it read, by recordTitle', async () => {
    meditClient.setQueryAnswer('getComparison', compare);
    meditClient.setQueryAnswer('getPlugins', plugins);
    const setTitle = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ setTitle }));

    expect(setTitle).toHaveBeenCalledWith('000001:A.esp');
  });

  it('leaves the title alone when the read fails', async () => {
    meditClient.setQueryFailure('getComparison', new Error('ECONNREFUSED'));
    meditClient.setQueryAnswer('getPlugins', plugins);
    const setTitle = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ setTitle }));

    expect(setTitle).not.toHaveBeenCalled();
  });

  it('asks the comparison by the message\'s own formKey', async () => {
    meditClient.setQueryAnswer('getComparison', compare);
    meditClient.setQueryAnswer('getPlugins', plugins);

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply: vi.fn() }));

    expect(meditClient.calls).toContainEqual({ method: 'getComparison', args: ['000001:A.esp'] });
  });

  it('writes a failed comparison to the Output, naming the record', async () => {
    meditClient.setQueryFailure('getComparison', new Error('ECONNREFUSED'));
    meditClient.setQueryAnswer('getPlugins', plugins);
    const channel = fakeChannel();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply: vi.fn(), channel }));

    expect(channel.warn).toHaveBeenCalledWith('Failed to read 000001:A.esp: ECONNREFUSED');
  });

  it('fails the whole load when the comparison itself fails', async () => {
    meditClient.setQueryFailure('getComparison', new Error('ECONNREFUSED'));
    meditClient.setQueryAnswer('getPlugins', plugins);
    const reply = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply }));

    expect(reply).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: false, error: 'ECONNREFUSED',
    });
  });

  // The rival: a client that fails the whole load when only the plugin list's own read fails,
  // rather than degrading that one slice to null.
  it('degrades the plugin list to null, rather than failing the load, when only it fails', async () => {
    meditClient.setQueryAnswer('getComparison', compare);
    meditClient.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));
    const reply = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply, conflictsComputed: () => false }));

    expect(reply).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false, loadFailures: [],
    });
  });
});
