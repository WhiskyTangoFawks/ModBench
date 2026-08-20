import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const executeCommand = vi.fn();
const writeText = vi.fn();
const createQuickPick = vi.fn();
const showQuickPick = vi.fn();

vi.mock('vscode', () => ({
  commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
  env: { clipboard: { writeText: (v: string) => writeText(v) } },
  window: {
    createQuickPick: (...args: unknown[]) => createQuickPick(...args),
    showQuickPick: (...args: unknown[]) => showQuickPick(...args),
  },
}));

// Issue #230: openExtendedFieldEditor has its own deep test suite (extendedFieldEditor.test.ts,
// which exercises the real temp-file/save/close mechanics) — this file only needs to prove the
// router dispatches OPEN_EXTENDED_EDITOR to it with the right params, so the function itself is
// mocked here rather than pulling its full vscode surface into this file's own vscode mock too.
const openExtendedFieldEditorMock = vi.fn();
vi.mock('./extendedFieldEditor', () => ({
  openExtendedFieldEditor: (...args: unknown[]) => openExtendedFieldEditorMock(...args),
}));

import {
  routeRecordPanelMessage, pickFormKeyViaQuickPick, normalizeFormKeyQuery, pickConditionFunctionViaQuickPick,
  type FormKeyPickerDeps, type ConditionFunctionPickerDeps, type RouteRecordPanelMessageDeps,
} from './recordPanelMessageRouter';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { RecordSummary } from './ApiClient';

beforeEach(() => { createQuickPick.mockClear(); showQuickPick.mockClear(); openExtendedFieldEditorMock.mockClear(); });

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}
const fakeReporter = { report: vi.fn() };

// #415: the edit path's two deps default to "applied, nobody listening" so every pre-existing case
// below keeps exercising exactly what it did; the edit tests override them explicitly.
// #426: searchRecords/getConditionFunctions are unused outside their own OPEN_*_PICKER tests below
// (which build their own *PickerDeps.repository), but both fields are required now that this
// router's shared `repository` field covers editField and both pickers' own catalogue fetches.
const fakeRepository = { editRecordField: vi.fn(), searchRecords: vi.fn(), getConditionFunctions: vi.fn() };
const onRecordEdited = vi.fn();

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return {
    channel: fakeChannel(), reporter: fakeReporter,
    repository: fakeRepository, onRecordEdited,
    // #426: undefined by default, matching every other per-panel bridge bundle — a message that
    // arrives with no deps wired is a no-op, not a crash.
    formKeyPicker: undefined,
    conditionFunctionPicker: undefined,
    extendedFieldEditor: undefined,
    ...overrides,
  };
}

function makeRecord(i: number, editorId: string | null = `Record${i}`): RecordSummary {
  return {
    formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`, plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: true, editorId,
    workingTreeState: 'None',
  };
}

// Issue #210 (#426: restored): a minimal fake of vscode.QuickPick — real VS Code has no test
// harness here, so this stands in for the event-emitter-driven object pickFormKeyViaQuickPick
// drives (value/items/activeItems/selectedItems as plain properties, onDidChangeValue/onDidAccept/
// onDidHide as listener registries the test triggers directly, matching real QuickPick's "calling
// .hide() also fires onDidHide" behavior).
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

// Issue #174: the record editor webview and the extension host are different processes, bridged
// only by `postMessage` — this is the single dispatch point for every message the webview sends
// up. #410/ADR-0041: three routes survive, all reads.
describe('routeRecordPanelMessage', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    writeText.mockReset();
    createQuickPick.mockReset();
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

    expect(onRecordEdited).toHaveBeenCalledWith('000800:Mod.esp', 'Mod.esp', 'SomeMod');
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

// Issue #210 (#426: restored): the FormKey picker as a native QuickPick — the extension-host half
// of the bridge pickFormKey (webview/src/nativeBridge.ts) talks to. Exercised directly here,
// separately from routeRecordPanelMessage's dispatch.
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

describe('routeRecordPanelMessage — OPEN_EXTENDED_EDITOR (issue #230)', () => {
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
      { requestId: 'r1', value: 'a long description', recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'MyMod.esp', origin: 'ModA', readOnly: true, column: undefined },
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

// Issue #211 (#426 Track 5: restored): the condition-function picker — unlike pickFormKeyViaQuickPick,
// the catalogue is bounded/game-scoped and fetched once, so this is a plain showQuickPick, not a
// debounced createQuickPick search.
describe('pickConditionFunctionViaQuickPick (issue #211)', () => {
  function fakeDeps(getConditionFunctions = vi.fn().mockResolvedValue([])): { deps: ConditionFunctionPickerDeps; getConditionFunctions: typeof getConditionFunctions; reply: ReturnType<typeof vi.fn> } {
    const reply = vi.fn();
    return { deps: { repository: { getConditionFunctions }, reply }, getConditionFunctions, reply };
  }

  it('fetches the catalogue and shows it via showQuickPick', async () => {
    const { deps, getConditionFunctions } = fakeDeps(vi.fn().mockResolvedValue(['GetIsID', 'GetDistance']));
    showQuickPick.mockResolvedValue('GetDistance');

    const result = await pickConditionFunctionViaQuickPick(deps, '');

    expect(getConditionFunctions).toHaveBeenCalled();
    expect(showQuickPick).toHaveBeenCalledWith(['GetIsID', 'GetDistance'], expect.objectContaining({ placeHolder: expect.any(String) }));
    expect(result).toBe('GetDistance');
  });

  it('sorts the seed to the front of the array when it is in the catalogue', async () => {
    const { deps } = fakeDeps(vi.fn().mockResolvedValue(['GetIsID', 'GetDistance', 'GetActorValue']));
    showQuickPick.mockResolvedValue(undefined);

    await pickConditionFunctionViaQuickPick(deps, 'GetDistance');

    expect(showQuickPick).toHaveBeenCalledWith(['GetDistance', 'GetIsID', 'GetActorValue'], expect.anything());
  });

  it('leaves the array unreordered when the seed is not in the catalogue', async () => {
    const { deps } = fakeDeps(vi.fn().mockResolvedValue(['GetIsID', 'GetDistance']));
    showQuickPick.mockResolvedValue(undefined);

    await pickConditionFunctionViaQuickPick(deps, 'NotReal');

    expect(showQuickPick).toHaveBeenCalledWith(['GetIsID', 'GetDistance'], expect.anything());
  });

  it('resolves null when dismissed without a selection', async () => {
    const { deps } = fakeDeps();
    showQuickPick.mockResolvedValue(undefined);

    expect(await pickConditionFunctionViaQuickPick(deps, '')).toBeNull();
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

  it('replies with the picked function name, correlated by requestId', async () => {
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetIsID']);
    const reply = vi.fn();
    showQuickPick.mockResolvedValue('GetIsID');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r1', seed: '' },
      makeDeps({ conditionFunctionPicker: { repository: { getConditionFunctions }, reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: 'r1', functionName: 'GetIsID' });
  });

  it('replies with functionName: null when dismissed without a selection', async () => {
    const getConditionFunctions = vi.fn().mockResolvedValue([]);
    const reply = vi.fn();
    showQuickPick.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r2', seed: '' },
      makeDeps({ conditionFunctionPicker: { repository: { getConditionFunctions }, reply } }),
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: 'r2', functionName: null });
  });
});
