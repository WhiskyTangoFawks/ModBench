import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  routeRecordPanelMessage, normalizeFormKeyQuery,
  type FormKeyPickerDeps, type RouteRecordPanelMessageDeps,
} from '../recordPanelMessageRouter';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../wire/messages';
import type { RecordSummary, CompareResult } from '../../client';
import { InMemoryMEditClient } from '../../client';
import { present } from '../../ports/present';
import { pluginMetadataFixture } from '../../client/test/fixtures';

beforeEach(() => { createQuickPick.mockClear(); showQuickPick.mockClear(); });

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}
const fakeReporter = { report: vi.fn(), landed: vi.fn(), insideDialog: vi.fn(), selectionOutcome: vi.fn() };

let meditClient: InMemoryMEditClient;

beforeEach(() => { meditClient = new InMemoryMEditClient(); });

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return {
    channel: fakeChannel(), reporter: fakeReporter,
    meditClient,
    panelId: 'record-panel-1',
    // Undefined by default: a message arriving with no deps wired is a no-op, not a crash.
    formKeyPicker: undefined,
    focusCell: vi.fn(),
    reply: vi.fn(),
    conflictsComputed: () => true,
    ...overrides,
  };
}

function makeRecord(i: number, editorId: string | null = `Record${i}`): RecordSummary {
  return {
    formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`, plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: true, editorId,
    origin: 'Data',
    workingTreeState: 'None',
    hasContainerChildren: false,
  hasParseFailure: false,
  };
}

// Stands in for vscode.QuickPick with no VS Code host: listener registries the test triggers
// directly, matching the real object's "calling .hide() also fires onDidHide".
function makeFakeQuickPick() {
  const changeValueListeners: Array<(v: string) => void> = [];
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    value: '',
    placeholder: undefined as string | undefined,
    items: [] as unknown[],
    activeItems: [] as unknown[],
    selectedItems: [] as unknown[],
    busy: false,
    show: vi.fn(),
    hide: vi.fn(() => { hideListeners.forEach(cb => cb()); }),
    dispose: vi.fn(),
    onDidChangeValue: (cb: (v: string) => void) => { changeValueListeners.push(cb); return { dispose: () => {} }; },
    onDidAccept: (cb: () => void) => { acceptListeners.push(cb); return { dispose: () => {} }; },
    onDidHide: (cb: () => void) => { hideListeners.push(cb); return { dispose: () => {} }; },
  };
  return {
    qp,
    // Arrow properties, not methods: none needs its own `this`, and destructuring one out
    // (`const { typeValue } = makeFakeQuickPick()`) must not trip unbound-method.
    typeValue: (v: string) => { qp.value = v; changeValueListeners.forEach(cb => cb(v)); },
    accept: () => { acceptListeners.forEach(cb => cb()); },
    hideWithoutAccept: () => { hideListeners.forEach(cb => cb()); },
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
    fakeReporter.report.mockReset();
  });

  it('OPEN_RECORD opens the named record in the editor', async () => {
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: '000001:Fallout4.esm' }, makeDeps());

    expect(executeCommand).toHaveBeenCalledWith(
      'modbench.record.open', { formKey: '000001:Fallout4.esm', label: '000001:Fallout4.esm' });
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
    await routeRecordPanelMessage(editMessage, makeDeps({ panelId: 'record-panel-3' }));

    expect(executeCommand).toHaveBeenCalledWith('modbench.record.editField', {
      formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'SomeMod', panelId: 'record-panel-3',
    }, envelope);
    expect(meditClient.calls).toEqual([]);
  });
});

describe('normalizeFormKeyQuery', () => {
  it('searches on the bracketed FormKey when a whole composite label is pasted', () => {
    expect(normalizeFormKeyQuery('DogmeatRace [000019:Fallout4.esm]')).toBe('000019:Fallout4.esm');
  });

  // The identity is the FormKey; the EditorID is decoration. A stale copy (the record was renamed
  // since) or a hand-edited string must resolve to the reference it names, not the name it carries.
  it('lets the FormKey win when the label and the bracketed FormKey disagree', () => {
    expect(normalizeFormKeyQuery('WrongName [000019:Fallout4.esm]')).toBe('000019:Fallout4.esm');
  });

  // A VMAD object reference reads "SomeNPC [000123:Foo.esp] [2]" — the alias suffix is a second
  // bracketed segment. Taking the first match is what makes a copy of that whole cell resolve.
  it('takes the first bracketed segment, so a VMAD alias suffix does not win over the FormKey', () => {
    expect(normalizeFormKeyQuery('SomeNPC [000123:Foo.esp] [2]')).toBe('000123:Foo.esp');
  });

  it('trims whitespace inside the brackets', () => {
    expect(normalizeFormKeyQuery('DogmeatRace [ 000019:Fallout4.esm ]')).toBe('000019:Fallout4.esm');
  });

  // A bare EditorID and a bare FormKey are both searched as typed.
  it('passes an unbracketed query through untouched', () => {
    expect(normalizeFormKeyQuery('Dogmeat')).toBe('Dogmeat');
    expect(normalizeFormKeyQuery('000019:Fallout4.esm')).toBe('000019:Fallout4.esm');
  });

  // Falling back to the query as typed rather than to the empty string: an empty capture would
  // blank the results list, which reads as "no matches" for something the user did type.
  it('falls back to the query as typed when the brackets are empty', () => {
    expect(normalizeFormKeyQuery('Foo []')).toBe('Foo []');
    expect(normalizeFormKeyQuery('Foo [  ]')).toBe('Foo [  ]');
  });

  it('passes an unclosed bracket through as typed', () => {
    expect(normalizeFormKeyQuery('Foo [000019')).toBe('Foo [000019');
  });
});

// The FormKey picker as a native QuickPick — the extension-host half of the bridge pickFormKey
// (webview/src/nativeBridge.ts) talks to. pickFormKeyViaQuickPick is not exported: every case
// drives it through routeRecordPanelMessage's own OPEN_FORM_KEY_PICKER dispatch, its one caller.
describe('routeRecordPanelMessage — OPEN_FORM_KEY_PICKER', () => {
  const REQUEST_ID = 'r1';

  function openPicker(seed: string, validTypes: string[], deps: FormKeyPickerDeps): Promise<void> {
    return routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: REQUEST_ID, seed, validTypes },
      makeDeps({ formKeyPicker: deps }),
    );
  }

  function fakeDeps(searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 })): { deps: FormKeyPickerDeps; searchRecords: typeof searchRecords; reply: ReturnType<typeof vi.fn> } {
    const reply = vi.fn();
    return { deps: { meditClient: { searchRecords }, reply }, searchRecords, reply };
  }

  afterEach(() => { vi.useRealTimers(); });

  it('with formKeyPicker deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: REQUEST_ID, seed: '', validTypes: [] },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('seeds the QuickPick value and immediately searches on the seed', async () => {
    const record = makeRecord(1, 'Seeded');
    const { deps, searchRecords } = fakeDeps(vi.fn().mockResolvedValue({ items: [record], total: 1 }));
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker(record.formKey, ['npc_'], deps);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));

    expect(qp.value).toBe(record.formKey);
    expect(searchRecords).toHaveBeenCalledWith(record.formKey, ['npc_']);
    expect(qp.items).toEqual([{ label: `Seeded [${record.formKey}]`, formKey: record.formKey }]);
    // "Pre-selected": the seeded record is the active item in the results list — QuickPick has
    // no InputBox-style valueSelection to also highlight the input text itself.
    expect(qp.activeItems).toEqual([{ label: `Seeded [${record.formKey}]`, formKey: record.formKey }]);

    qp.hide();
    await dispatchPromise;
  });

  // The seed is the composite the cell displays, not the bare FormKey. Search already normalizes
  // it; pre-selection must too, or comparing the raw seed against item.formKey stops matching.
  it('pre-selects the seeded record when the seed is a whole "EditorID [FormKey]" composite', async () => {
    const record = makeRecord(1, 'Seeded');
    const { deps, searchRecords } = fakeDeps(vi.fn().mockResolvedValue({ items: [record], total: 1 }));
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const composite = `Seeded [${record.formKey}]`;
    const dispatchPromise = openPicker(composite, ['npc_'], deps);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));

    expect(qp.value).toBe(composite);
    expect(searchRecords).toHaveBeenCalledWith(record.formKey, ['npc_']);
    expect(qp.activeItems).toEqual([{ label: composite, formKey: record.formKey }]);

    qp.hide();
    await dispatchPromise;
  });

  it('an empty seed does not search — items stay empty', async () => {
    const { deps, searchRecords } = fakeDeps();
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', [], deps);
    await Promise.resolve();

    expect(searchRecords).not.toHaveBeenCalled();
    expect(qp.items).toEqual([]);

    qp.hide();
    await dispatchPromise;
  });

  // Pasting a whole "EditorID [FormKey]" label copied from a cell searches on the FormKey, not
  // on the literal — the normalizer's one wiring point.
  it('normalizes a pasted composite label to its FormKey before searching', async () => {
    vi.useFakeTimers();
    const { deps, searchRecords } = fakeDeps();
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', [], deps);
    searchRecords.mockClear();

    typeValue('DogmeatRace [000019:Fallout4.esm]');
    await vi.advanceTimersByTimeAsync(200);
    expect(searchRecords).toHaveBeenCalledWith('000019:Fallout4.esm', []);

    qp.hide();
    await dispatchPromise;
  });

  it('debounces onDidChangeValue by 200ms, searching once with the settled value', async () => {
    vi.useFakeTimers();
    const record = makeRecord(2, 'Sword');
    const { deps, searchRecords } = fakeDeps(vi.fn().mockResolvedValue({ items: [record], total: 1 }));
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', [], deps);
    searchRecords.mockClear(); // drop the (no-op, empty-seed) call above

    typeValue('sw');
    await vi.advanceTimersByTimeAsync(100);
    typeValue('swor');
    await vi.advanceTimersByTimeAsync(199);
    expect(searchRecords).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(searchRecords).toHaveBeenCalledTimes(1);
    expect(searchRecords).toHaveBeenCalledWith('swor', []);

    qp.hide();
    await dispatchPromise;
  });

  it('clears items immediately when the value is emptied, without waiting for the debounce', async () => {
    vi.useFakeTimers();
    const { deps } = fakeDeps();
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', [], deps);
    typeValue('sw');
    qp.items = [{ label: 'stale', formKey: 'x' }];
    typeValue('');

    expect(qp.items).toEqual([]);

    qp.hide();
    await dispatchPromise;
  });

  it('drops a stale search response that resolves after a newer one', async () => {
    let resolveFirst!: (v: { items: RecordSummary[]; total: number }) => void;
    let resolveSecond!: (v: { items: RecordSummary[]; total: number }) => void;
    const searchRecords = vi.fn()
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));
    const { deps } = fakeDeps(searchRecords);
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('first', [], deps);
    vi.useFakeTimers();
    typeValue('second');
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();

    // Second (newer) search resolves first; first (stale) resolves after — its late arrival must
    // not clobber the newer result.
    const secondRecord = makeRecord(9, 'Second');
    resolveSecond({ items: [secondRecord], total: 1 });
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));
    resolveFirst({ items: [makeRecord(1, 'First')], total: 1 });
    await Promise.resolve();

    expect(qp.items).toEqual([{ label: `Second [${secondRecord.formKey}]`, formKey: secondRecord.formKey }]);

    qp.hide();
    await dispatchPromise;
  });

  it('opens a QuickPick and replies with the picked FormKey, correlated by requestId, hiding and disposing it', async () => {
    const { deps, reply } = fakeDeps();
    const { qp, accept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', ['npc_'], deps);
    qp.selectedItems = [{ label: 'Picked [X]', formKey: 'X' }];
    accept();
    await dispatchPromise;

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: REQUEST_ID, formKey: 'X' });
    expect(qp.hide).toHaveBeenCalled();
    expect(qp.dispose).toHaveBeenCalled();
  });

  it('replies with formKey: null and disposes the picker when dismissed without a selection', async () => {
    const { deps, reply } = fakeDeps();
    const { qp, hideWithoutAccept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', [], deps);
    hideWithoutAccept();
    await dispatchPromise;

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: REQUEST_ID, formKey: null });
    expect(qp.dispose).toHaveBeenCalled();
  });
});

describe('routeRecordPanelMessage — the focused cell', () => {
  it('hands the panel\'s focused cell to its own tracker, and null as no cell', async () => {
    const focusCell = vi.fn();
    const context = { webviewSection: 'stringValue', formKey: '000001:A.esp' };

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context }, makeDeps({ focusCell }));
    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null }, makeDeps({ focusCell }));

    expect(focusCell.mock.calls).toEqual([[context], [undefined]]);
  });
});

// ADR-0002 invariant 2: RecordPanelClient's own read, asked of the mEdit client through the host
// rather than fetched by the webview itself.
describe('routeRecordPanelMessage — REQUEST_RECORD_LOAD', () => {
  const compare: CompareResult = { overrides: [], diffs: [], conflictAll: 'OnlyOne' };
  const plugins = [pluginMetadataFixture({ name: 'A.esp', isImmutable: true })];
  const loadMessage = { type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: 'r1', formKey: '000001:A.esp' };

  it('answers with the comparison, the plugin list and the settled conflictsComputed', async () => {
    meditClient.setQueryAnswer('getComparison', compare);
    meditClient.setQueryAnswer('getPlugins', plugins);
    const reply = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply, conflictsComputed: () => true }));

    expect(reply).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins, conflictsComputed: true,
    });
  });

  it('answers a record held by no active plugin as a null comparison, not a failure', async () => {
    meditClient.setQueryAnswer('getComparison', null);
    meditClient.setQueryAnswer('getPlugins', plugins);
    const reply = vi.fn();

    await routeRecordPanelMessage(loadMessage, makeDeps({ reply, conflictsComputed: () => true }));

    expect(reply).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare: null, plugins, conflictsComputed: true,
    });
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
      type: EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED, requestId: 'r1', ok: true, compare, plugins: null, conflictsComputed: false,
    });
  });
});
