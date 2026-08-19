import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const executeCommand = vi.fn();
const createQuickPick = vi.fn();
const showQuickPick = vi.fn();
const showWarningMessage = vi.fn();
const showInputBox = vi.fn();
const writeText = vi.fn();
const readText = vi.fn();
vi.mock('vscode', () => ({
  commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
  window: {
    createQuickPick: (...args: unknown[]) => createQuickPick(...args),
    showQuickPick: (...args: unknown[]) => showQuickPick(...args),
    showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
    showInputBox: (...args: unknown[]) => showInputBox(...args),
  },
  env: { clipboard: { writeText: (...args: unknown[]) => writeText(...args), readText: (...args: unknown[]) => readText(...args) } },
}));

// Issue #230: openExtendedFieldEditor has its own deep test suite (extendedFieldEditor.test.ts,
// which exercises the real temp-file/save/close mechanics) — this file only needs to prove the
// router dispatches OPEN_EXTENDED_EDITOR to it with the right params, so the function itself is
// mocked here rather than pulling its full vscode surface (openTextDocument/showTextDocument/
// onDidSaveTextDocument/onDidCloseTextDocument) into this file's own vscode mock too.
const openExtendedFieldEditorMock = vi.fn();
vi.mock('./extendedFieldEditor', () => ({
  openExtendedFieldEditor: (...args: unknown[]) => openExtendedFieldEditorMock(...args),
}));

import {
  routeRecordPanelMessage, pickFormKeyViaQuickPick, pickConditionFunctionViaQuickPick,
  confirmRevertGroupViaNativeDialog, pickScriptNameViaInputBox, normalizeFormKeyQuery,
  type FormKeyPickerDeps, type ConditionFunctionPickerDeps, type RouteRecordPanelMessageDeps,
} from './recordPanelMessageRouter';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { RecordSummary } from './ApiClient';

// Issue #174: routeRecordPanelMessage is the extracted, unit-testable body of
// openRecordPanel's onDidReceiveMessage handler in extension.ts — the single dispatch point
// for every message the record editor webview posts up. Pulled out here specifically so this
// logic (the pre-existing OPEN_RECORD branch and the PENDING_CHANGED/LOG branches) has a seam
// that doesn't require a real VS Code test harness. Issue #208: REVEAL_PENDING_CHANGE is no
// since resolving a changeId to a tree node never needed the webview in the first place.

beforeEach(() => { createQuickPick.mockClear(); showQuickPick.mockClear(); showWarningMessage.mockClear(); showInputBox.mockClear(); });

// Issue #224: fake Reporter (ADR-0026) every routeRecordPanelMessage call now needs —
// COPY_TO_CLIPBOARD's failure path reports through it. Shared across every deps object in this
// file the same way `channel`'s fakeChannel() is, since no test besides the rejection-path one
// below cares what it received.
const report = vi.fn();
const fakeReporter = { report: (...args: unknown[]) => report(...args) };

// #200: fake of the leveled 'Modbench' channel Pick the router forwards LOG messages to.
function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function makeRecord(i: number, editorId: string | null = `Record${i}`): RecordSummary {
  return { formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`, plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: true, editorId };
}

// Issue #210: a minimal fake of vscode.QuickPick — real VS Code has no test harness here, so this
// stands in for the event-emitter-driven object pickFormKeyViaQuickPick drives (value/items/
// activeItems/selectedItems as plain properties, onDidChangeValue/onDidAccept/onDidHide as
// listener registries the test triggers directly, matching real QuickPick's "calling .hide() also
// fires onDidHide" behavior).
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
    typeValue(v: string) { qp.value = v; changeValueListeners.forEach(cb => cb(v)); },
    accept() { acceptListeners.forEach(cb => cb()); },
    hideWithoutAccept() { hideListeners.forEach(cb => cb()); },
  };
}

// Issue #234: every routeRecordPanelMessage call site needs a full RouteRecordPanelMessageDeps —
// baseDeps() is the "nothing wired" state (matches most call sites verbatim: reveal/formKeyPicker/
// conditionFunctionPicker/revertGroupConfirm/addScriptName/clipboardRead/extendedFieldEditor all
// undefined, which every read site optional-chains past safely), makeDeps(overrides) layers the
// one or two fields a given test actually cares about on top. channel/reporter aren't optional in
// the real type, so they still need a real default (fakeChannel()/the shared fakeReporter) here.
// A test that asserts on a spy (reveal's refresh/revealFn/log, channel's debug/info/warn, or a
// bridge's reply) still builds that piece itself and passes it in via overrides, so spy identity
// is never lost to this helper.
function baseDeps(): RouteRecordPanelMessageDeps {
  return {
    channel: fakeChannel(),
    formKeyPicker: undefined,
    conditionFunctionPicker: undefined,
    revertGroupConfirm: undefined,
    addScriptName: undefined,
    clipboardRead: undefined,
    reporter: fakeReporter,
    extendedFieldEditor: undefined,
  };
}

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return { ...baseDeps(), ...overrides };
}

describe('routeRecordPanelMessage', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    report.mockClear();
    writeText.mockClear();
    readText.mockClear();
  });

  it('OPEN_RECORD executes modbench.openEditor with formKey and label', async () => {
    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: '000001:Fallout4.esm' }, makeDeps());

    expect(executeCommand).toHaveBeenCalledWith('modbench.openEditor', { formKey: '000001:Fallout4.esm', label: '000001:Fallout4.esm' });
  });

  it('an unrecognized message type is a no-op', async () => {
    await routeRecordPanelMessage({ type: 'somethingElse' }, makeDeps());

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('a non-object message is a no-op', async () => {
    await expect(routeRecordPanelMessage('not an object', makeDeps())).resolves.toBeUndefined();
    await expect(routeRecordPanelMessage(null, makeDeps())).resolves.toBeUndefined();
  });

  // Issue #200: the webview has no route to the 'Modbench' channel of its own — LOG is the
  // bridge. The router does no interpretation, just a level→method forward.
  it('LOG at debug level forwards the message to channel.debug', async () => {
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'debug', message: 'staged edit' }, makeDeps({ channel }));

    expect(channel.debug).toHaveBeenCalledWith('staged edit');
    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
  });

  it('LOG at info level forwards the message to channel.info', async () => {
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'info', message: 'saved group' }, makeDeps({ channel }));

    expect(channel.info).toHaveBeenCalledWith('saved group');
    expect(channel.debug).not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
  });

  it('LOG at warn level forwards the message to channel.warn', async () => {
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn', message: 'rejected drop' }, makeDeps({ channel }));

    expect(channel.warn).toHaveBeenCalledWith('rejected drop');
    expect(channel.debug).not.toHaveBeenCalled();
    expect(channel.info).not.toHaveBeenCalled();
  });

  it('LOG with reveal deps undefined still forwards to the channel', async () => {
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'debug', message: 'x' }, makeDeps({ channel }));

    expect(channel.debug).toHaveBeenCalledWith('x');
  });

  // Issue #224: Ctrl+C's clipboard write. `vscode.env.clipboard.writeText` is extension-host-only,
  // so DiffRow posts the already-computed model value up here — fire-and-forget, no reply, no
  // deps bundle (unlike the *Picker/*Confirm/*Name bridges, nothing needs to come back).
  it('COPY_TO_CLIPBOARD writes the message value to the system clipboard', async () => {
    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value: 'Dogmeat [000001:Fallout4.esm]' }, makeDeps());

    expect(writeText).toHaveBeenCalledWith('Dogmeat [000001:Fallout4.esm]');
    expect(report).not.toHaveBeenCalled();
  });

  // Issue #224, review follow-up: a rejected clipboard write must not become an unhandled promise
  // rejection (this branch is called `void`-fire-and-forget from extension.ts's
  // onDidReceiveMessage) or a silent swallow — modbench/CLAUDE.md's "every catch logs to the
  // channel before showing UI or swallowing" rule, and ADR-0026 classifies a failed Ctrl+C as an
  // "explicit action failed" (the user pressed the key) needing an error notification + log. A
  // clipboard write is a real failure mode here (headless/remote sessions, missing Linux
  // clipboard tooling, Wayland permissions), not a theoretical one.
  it('COPY_TO_CLIPBOARD reports (not throws) when the clipboard write rejects', async () => {
    const failure = new Error('clipboard unavailable');
    writeText.mockRejectedValueOnce(failure);

    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value: 'Dogmeat [000001:Fallout4.esm]' },
      makeDeps(),
    )).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledWith('error', 'Could not copy to the clipboard.', 'clipboard unavailable');
  });
});

// Issue #218: FormKey cells now display "EditorID [FormKey]" (the same composite the picker's own
// items have always used), so copying a cell and pasting it into another FormKey cell's picker
// puts a whole label into the query. Searching for the literal would find nothing. The normalizer
// is the whole fix, and it lives here rather than in the backend: it is format knowledge about a
// label this frontend invented, and it serves typed and pasted input identically.
describe('normalizeFormKeyQuery (issue #218)', () => {
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

  // #210's behaviour, unchanged: a bare EditorID and a bare FormKey are both searched as typed.
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

// Issue #210: the FormKey picker as a native QuickPick — the extension-host half of the bridge
// pickFormKey (webview/src/nativeBridge.ts) talks to. Exercised directly here (like
// revealPendingChange above), separately from routeRecordPanelMessage's dispatch.
describe('pickFormKeyViaQuickPick (issue #210)', () => {
  function fakeDeps(searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 })): { deps: FormKeyPickerDeps; searchRecords: typeof searchRecords; reply: ReturnType<typeof vi.fn> } {
    const reply = vi.fn();
    return { deps: { repository: { searchRecords }, reply }, searchRecords, reply };
  }

  afterEach(() => { vi.useRealTimers(); });

  it('seeds the QuickPick value and immediately searches on the seed', async () => {
    const record = makeRecord(1, 'Seeded');
    const { deps, searchRecords } = fakeDeps(vi.fn().mockResolvedValue({ items: [record], total: 1 }));
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, record.formKey, ['npc_']);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));

    expect(qp.value).toBe(record.formKey);
    expect(searchRecords).toHaveBeenCalledWith(record.formKey, ['npc_']);
    expect(qp.items).toEqual([{ label: `Seeded [${record.formKey}]`, formKey: record.formKey }]);
    // "Pre-selected": the seeded record is the active item in the results list — QuickPick has
    // no InputBox-style valueSelection to also highlight the input text itself.
    expect(qp.activeItems).toEqual([{ label: `Seeded [${record.formKey}]`, formKey: record.formKey }]);

    qp.hide();
    await resultPromise;
  });

  // Issue #218 AC 3: the seed is the composite the cell displays, not the bare FormKey, so that a
  // *mutable* FormKey cell can hand over what it shows — the picker's input is native, so Ctrl+A/
  // Ctrl+C there is the copy path on a column that has no read-only surface. The search half
  // already tolerated this (normalizeFormKeyQuery), but pre-selection compared the raw seed
  // against item.formKey and would have silently stopped matching.
  it('pre-selects the seeded record when the seed is a whole "EditorID [FormKey]" composite', async () => {
    const record = makeRecord(1, 'Seeded');
    const { deps, searchRecords } = fakeDeps(vi.fn().mockResolvedValue({ items: [record], total: 1 }));
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const composite = `Seeded [${record.formKey}]`;
    const resultPromise = pickFormKeyViaQuickPick(deps, composite, ['npc_']);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));

    expect(qp.value).toBe(composite);
    expect(searchRecords).toHaveBeenCalledWith(record.formKey, ['npc_']);
    expect(qp.activeItems).toEqual([{ label: composite, formKey: record.formKey }]);

    qp.hide();
    await resultPromise;
  });

  it('an empty seed does not search — items stay empty', async () => {
    const { deps, searchRecords } = fakeDeps();
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, '', []);
    await Promise.resolve();

    expect(searchRecords).not.toHaveBeenCalled();
    expect(qp.items).toEqual([]);

    qp.hide();
    await resultPromise;
  });

  // Issue #218: pasting a whole "EditorID [FormKey]" label copied from a cell searches on the
  // FormKey, not on the literal — the normalizer's one wiring point. The unbracketed case is
  // covered by the debounce test below, which is #210's behaviour and must not regress.
  it('normalizes a pasted composite label to its FormKey before searching', async () => {
    vi.useFakeTimers();
    const { deps, searchRecords } = fakeDeps();
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, '', []);
    searchRecords.mockClear();

    typeValue('DogmeatRace [000019:Fallout4.esm]');
    await vi.advanceTimersByTimeAsync(200);
    expect(searchRecords).toHaveBeenCalledWith('000019:Fallout4.esm', []);

    qp.hide();
    await resultPromise;
  });

  it('debounces onDidChangeValue by 200ms, searching once with the settled value', async () => {
    vi.useFakeTimers();
    const record = makeRecord(2, 'Sword');
    const { deps, searchRecords } = fakeDeps(vi.fn().mockResolvedValue({ items: [record], total: 1 }));
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, '', []);
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
    await resultPromise;
  });

  it('clears items immediately when the value is emptied, without waiting for the debounce', async () => {
    vi.useFakeTimers();
    const { deps } = fakeDeps();
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, '', []);
    typeValue('sw');
    qp.items = [{ label: 'stale', formKey: 'x' }];
    typeValue('');

    expect(qp.items).toEqual([]);

    qp.hide();
    await resultPromise;
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

    const resultPromise = pickFormKeyViaQuickPick(deps, 'first', []);
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
    await resultPromise;
  });

  it('resolves with the selected FormKey on accept, and hides/disposes the picker', async () => {
    const { deps } = fakeDeps();
    const { qp, accept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, '', []);
    qp.selectedItems = [{ label: 'Picked [X]', formKey: 'X' }];
    accept();

    expect(await resultPromise).toBe('X');
    expect(qp.hide).toHaveBeenCalled();
    expect(qp.dispose).toHaveBeenCalled();
  });

  it('resolves null when hidden without accepting (Escape/blur) — no selection is treated as unchanged', async () => {
    const { deps } = fakeDeps();
    const { qp, hideWithoutAccept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const resultPromise = pickFormKeyViaQuickPick(deps, '', []);
    hideWithoutAccept();

    expect(await resultPromise).toBeNull();
    expect(qp.dispose).toHaveBeenCalled();
  });
});

describe('routeRecordPanelMessage — OPEN_FORM_KEY_PICKER (issue #210)', () => {
  it('with formKeyPicker deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: [] },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('opens a QuickPick and replies with the picked FormKey, correlated by requestId', async () => {
    const searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const reply = vi.fn();
    const { qp, accept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: ['npc_'] },
      makeDeps({ formKeyPicker: { repository: { searchRecords }, reply } }),
    );
    qp.selectedItems = [{ label: 'Picked [X]', formKey: 'X' }];
    accept();
    await dispatchPromise;

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: 'r1', formKey: 'X' });
  });

  it('replies with formKey: null when the picker is dismissed without a selection', async () => {
    const searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const reply = vi.fn();
    const { qp, hideWithoutAccept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r2', seed: '', validTypes: [] },
      makeDeps({ formKeyPicker: { repository: { searchRecords }, reply } }),
    );
    hideWithoutAccept();
    await dispatchPromise;

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: 'r2', formKey: null });
  });
});

// Issue #211: the condition-function picker as a native QuickPick — unlike #210's FormKey picker
// (pickFormKeyViaQuickPick above), the catalogue is bounded/game-scoped and fetched once, so this
// is a plain `showQuickPick` over a fetched array rather than a debounced `createQuickPick`
// search. "Seeded with the current value" means the seed is sorted to array index 0 —
// showQuickPick has no activeItem option, so array order is the only way to pre-highlight an item
// (VS Code focuses the first item by default).
describe('pickConditionFunctionViaQuickPick (issue #211)', () => {
  function fakeDeps(getConditionFunctions = vi.fn().mockResolvedValue([])): {
    deps: ConditionFunctionPickerDeps; getConditionFunctions: typeof getConditionFunctions; reply: ReturnType<typeof vi.fn>;
  } {
    const reply = vi.fn();
    return { deps: { repository: { getConditionFunctions }, reply }, getConditionFunctions, reply };
  }

  it('fetches the catalogue exactly once and sorts the current value to index 0', async () => {
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetDistance', 'GetIsID', 'GetStageDone']);
    const { deps } = fakeDeps(getConditionFunctions);
    showQuickPick.mockResolvedValue(undefined);

    await pickConditionFunctionViaQuickPick(deps, 'GetIsID');

    expect(getConditionFunctions).toHaveBeenCalledTimes(1);
    expect(showQuickPick).toHaveBeenCalledWith(
      ['GetIsID', 'GetDistance', 'GetStageDone'],
      expect.anything(),
    );
  });

  it('passes the catalogue through unreordered when the seed is empty (adding a value with no prior function)', async () => {
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']);
    const { deps } = fakeDeps(getConditionFunctions);
    showQuickPick.mockResolvedValue(undefined);

    await pickConditionFunctionViaQuickPick(deps, '');

    expect(showQuickPick).toHaveBeenCalledWith(['GetDistance', 'GetIsID'], expect.anything());
  });

  it('resolves with the picked function name', async () => {
    const { deps } = fakeDeps(vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']));
    showQuickPick.mockResolvedValue('GetDistance');

    expect(await pickConditionFunctionViaQuickPick(deps, 'GetIsID')).toBe('GetDistance');
  });

  it('resolves null when dismissed without a selection (Escape/blur) — the condition is left unchanged', async () => {
    const { deps } = fakeDeps(vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']));
    showQuickPick.mockResolvedValue(undefined);

    expect(await pickConditionFunctionViaQuickPick(deps, 'GetIsID')).toBeNull();
  });
});

describe('routeRecordPanelMessage — OPEN_CONDITION_FUNCTION_PICKER (issue #211)', () => {
  it('with conditionFunctionPicker deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r1', seed: '' },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('opens a QuickPick and replies with the picked function, correlated by requestId', async () => {
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']);
    const reply = vi.fn();
    showQuickPick.mockResolvedValue('GetDistance');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r1', seed: 'GetIsID' },
      makeDeps({ conditionFunctionPicker: { repository: { getConditionFunctions }, reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: 'r1', functionName: 'GetDistance' });
  });

  it('replies with functionName: null when the picker is dismissed without a selection', async () => {
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']);
    const reply = vi.fn();
    showQuickPick.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r2', seed: '' },
      makeDeps({ conditionFunctionPicker: { repository: { getConditionFunctions }, reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: 'r2', functionName: null });
  });
});

// Issue #212: the revert-group confirmation as a native modal warning — the extension-host half
// of the bridge confirmRevertGroup (webview/src/nativeBridge.ts) talks to. Exercised
// directly here, like pickFormKeyViaQuickPick/pickConditionFunctionViaQuickPick above. Takes no
// deps (RevertGroupConfirmDeps carries only `reply`, exercised via routeRecordPanelMessage below).
describe('confirmRevertGroupViaNativeDialog (issue #212)', () => {
  it('shows a modal warning with a Revert action and the given detail text', async () => {
    showWarningMessage.mockResolvedValue(undefined);

    await confirmRevertGroupViaNativeDialog('Npc / 000001:Fallout4.esm · Name');

    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ modal: true, detail: 'Npc / 000001:Fallout4.esm · Name' }),
      'Revert',
    );
  });

  it('resolves true when Revert is picked', async () => {
    showWarningMessage.mockResolvedValue('Revert');

    expect(await confirmRevertGroupViaNativeDialog('detail')).toBe(true);
  });

  it('resolves false when the modal is dismissed (Cancel or Escape/outside click)', async () => {
    showWarningMessage.mockResolvedValue(undefined);

    expect(await confirmRevertGroupViaNativeDialog('detail')).toBe(false);
  });
});

describe('routeRecordPanelMessage — OPEN_REVERT_GROUP_CONFIRM (issue #212)', () => {
  it('with revertGroupConfirm deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId: 'r1', detail: 'x' },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows the modal with the given detail and replies with confirmed: true, correlated by requestId', async () => {
    const reply = vi.fn();
    showWarningMessage.mockResolvedValue('Revert');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId: 'r1', detail: 'Npc / X · Name' },
      makeDeps({ revertGroupConfirm: { reply } }),
    );

    expect(showWarningMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modal: true, detail: 'Npc / X · Name' }), 'Revert');
    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: 'r1', confirmed: true });
  });

  it('replies with confirmed: false when the modal is dismissed', async () => {
    const reply = vi.fn();
    showWarningMessage.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId: 'r2', detail: 'x' },
      makeDeps({ revertGroupConfirm: { reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: 'r2', confirmed: false });
  });
});

// Issue #212: the add-script dialog's name field as a native input box — the extension-host half
// of the bridge pickScriptName (webview/src/nativeBridge.ts) talks to.
describe('pickScriptNameViaInputBox (issue #212)', () => {
  it('shows an input box with a prompt', async () => {
    showInputBox.mockResolvedValue('MyScript');

    await pickScriptNameViaInputBox();

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.any(String) }));
  });

  it('resolves with the entered name when accepted', async () => {
    showInputBox.mockResolvedValue('MyScript');

    expect(await pickScriptNameViaInputBox()).toBe('MyScript');
  });

  it('resolves null when dismissed (Escape/blur)', async () => {
    showInputBox.mockResolvedValue(undefined);

    expect(await pickScriptNameViaInputBox()).toBeNull();
  });

  it('validateInput rejects an empty or whitespace-only name, accepts a real one', async () => {
    showInputBox.mockResolvedValue('X');
    await pickScriptNameViaInputBox();

    const validateInput = showInputBox.mock.calls.at(-1)?.[0]?.validateInput as (v: string) => string | null | undefined;
    expect(validateInput('')).toEqual(expect.any(String));
    expect(validateInput('   ')).toEqual(expect.any(String));
    expect(validateInput('MyScript')).toBeFalsy();
  });
});

describe('routeRecordPanelMessage — OPEN_ADD_SCRIPT_NAME (issue #212)', () => {
  it('with addScriptName deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId: 'r1' },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('shows the input box and replies with the entered name, correlated by requestId', async () => {
    const reply = vi.fn();
    showInputBox.mockResolvedValue('MyScript');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId: 'r1' },
      makeDeps({ addScriptName: { reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: 'r1', name: 'MyScript' });
  });

  it('replies with name: null when the input box is dismissed', async () => {
    const reply = vi.fn();
    showInputBox.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId: 'r2' },
      makeDeps({ addScriptName: { reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: 'r2', name: null });
  });
});

// Issue #225: Ctrl+V's clipboard read — the extension-host half of the bridge readClipboardText
// (webview/src/nativeBridge.ts) talks to. Same request/reply shape as OPEN_ADD_SCRIPT_NAME above
// (ClipboardReadDeps carries only `reply`), plus its own failure-reporting path mirroring
// COPY_TO_CLIPBOARD's (#224 review) since a clipboard read can fail the same way a write can.
describe('routeRecordPanelMessage — READ_CLIPBOARD (issue #225)', () => {
  // report/readText are shared fakes declared file-wide — this describe block is a sibling of
  // 'routeRecordPanelMessage' above (not nested in it), so its own beforeEach's mockClear never
  // runs for these tests; cleared here instead so an earlier COPY_TO_CLIPBOARD assertion can't
  // leak into this block's own "report not called" checks.
  beforeEach(() => { report.mockClear(); readText.mockClear(); });

  it('with clipboardRead deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.READ_CLIPBOARD, requestId: 'r1' },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads the system clipboard and replies with the text, correlated by requestId', async () => {
    const reply = vi.fn();
    readText.mockResolvedValue('Dogmeat [000001:Fallout4.esm]');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.READ_CLIPBOARD, requestId: 'r1' },
      makeDeps({ clipboardRead: { reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CLIPBOARD_READ, requestId: 'r1', value: 'Dogmeat [000001:Fallout4.esm]' });
    expect(report).not.toHaveBeenCalled();
  });

  // A rejected read must not become an unhandled promise rejection or a silent swallow —
  // modbench/CLAUDE.md's "every catch logs to the channel before showing UI or swallowing" rule —
  // and ADR-0026 classifies a failed Ctrl+V as an "explicit action failed" needing an error
  // notification + log, same as #224's COPY_TO_CLIPBOARD failure path. Replies with value: null so
  // the webview's paste handler treats it the same as an empty clipboard: leave the field unchanged.
  it('replies with value: null and reports (not throws) when the clipboard read rejects', async () => {
    const reply = vi.fn();
    readText.mockRejectedValueOnce(new Error('clipboard unavailable'));

    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.READ_CLIPBOARD, requestId: 'r2' },
      makeDeps({ clipboardRead: { reply } }),
    )).resolves.toBeUndefined();

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CLIPBOARD_READ, requestId: 'r2', value: null });
    expect(report).toHaveBeenCalledWith('error', 'Could not read the clipboard.', 'clipboard unavailable');
  });
});

// Issue #230: the OPEN_EXTENDED_EDITOR branch — see extendedFieldEditor.test.ts for the deep
// (temp-file/save/close) behavior; this only proves routeRecordPanelMessage wires the message's
// fields through to openExtendedFieldEditor's params, using the same deps-optional-is-a-no-op
// convention as every other *Picker/*Confirm/*Name/clipboardRead branch above.
describe('routeRecordPanelMessage — OPEN_EXTENDED_EDITOR (issue #230)', () => {
  beforeEach(() => { openExtendedFieldEditorMock.mockClear(); });

  it('with extendedFieldEditor deps undefined is a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'MyMod.esp', origin: 'Data', readOnly: false },
      makeDeps(),
    )).resolves.toBeUndefined();
    expect(openExtendedFieldEditorMock).not.toHaveBeenCalled();
  });

  it('forwards the message identity/value/readOnly and the deps bundle to openExtendedFieldEditor', async () => {
    const reply = vi.fn();
    const extendedFieldEditorDeps = { tempRoot: '/tmp/x', reply, log: vi.fn(), reporter: fakeReporter };

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId: 'r1', value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'MyMod.esp', origin: 'ModA', readOnly: true },
      makeDeps({ extendedFieldEditor: extendedFieldEditorDeps }),
    );

    expect(openExtendedFieldEditorMock).toHaveBeenCalledWith(
      { requestId: 'r1', value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'MyMod.esp', origin: 'ModA', readOnly: true },
      extendedFieldEditorDeps,
    );
  });

  // #272 / ADR-0036: origin is forwarded even though extendedEditorPath doesn't use it yet
  // (unreachable path collision until #34) — the router's own job is just faithful forwarding.
  it('forwards origin through to openExtendedFieldEditor', async () => {
    const reply = vi.fn();
    const extendedFieldEditorDeps = { tempRoot: '/tmp/x', reply, log: vi.fn(), reporter: fakeReporter };

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId: 'r1', value: 'x', recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModB', readOnly: false },
      makeDeps({ extendedFieldEditor: extendedFieldEditorDeps }),
    );

    expect(openExtendedFieldEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'Shared.esp', origin: 'ModB' }),
      extendedFieldEditorDeps,
    );
  });

  // Issue #242: the pending column's own request carries `column: 'pending'` — forwarded through
  // to openExtendedFieldEditor's params so its tab identity stays independent of the disk cell's.
  it('forwards column: "pending" through to openExtendedFieldEditor for a pending-cell request', async () => {
    const reply = vi.fn();
    const extendedFieldEditorDeps = { tempRoot: '/tmp/x', reply, log: vi.fn(), reporter: fakeReporter };

    await routeRecordPanelMessage(
      {
        type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId: 'r1', value: 'staged value',
        recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'MyMod.esp', origin: 'Data',
        readOnly: false, column: 'pending',
      },
      makeDeps({ extendedFieldEditor: extendedFieldEditorDeps }),
    );

    expect(openExtendedFieldEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ column: 'pending' }),
      extendedFieldEditorDeps,
    );
  });
});
