import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const executeCommand = vi.fn();
const createQuickPick = vi.fn();
const showQuickPick = vi.fn();
const showWarningMessage = vi.fn();
const showInputBox = vi.fn();
vi.mock('vscode', () => ({
  commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
  window: {
    createQuickPick: (...args: unknown[]) => createQuickPick(...args),
    showQuickPick: (...args: unknown[]) => showQuickPick(...args),
    showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
    showInputBox: (...args: unknown[]) => showInputBox(...args),
  },
}));

import {
  routeRecordPanelMessage, revealPendingChange, pickFormKeyViaQuickPick, pickConditionFunctionViaQuickPick,
  confirmRevertGroupViaNativeDialog, pickScriptNameViaInputBox, normalizeFormKeyQuery,
  type RevealDeps, type FormKeyPickerDeps, type ConditionFunctionPickerDeps,
} from './recordPanelMessageRouter';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { PendingTreeNode } from './PendingChangesTreeProvider';
import type { RecordSummary } from './ApiClient';

// Issue #174: routeRecordPanelMessage is the extracted, unit-testable body of
// openRecordPanel's onDidReceiveMessage handler in extension.ts — the single dispatch point
// for every message the record editor webview posts up. Pulled out here specifically so this
// logic (the pre-existing OPEN_RECORD branch and the PENDING_CHANGED/LOG branches) has a seam
// that doesn't require a real VS Code test harness. Issue #208: REVEAL_PENDING_CHANGE is no
// longer one of these branches — reveal is now the native `modbench.pendingCell.reveal`
// command calling the exported `revealPendingChange` directly (see the describe block below),
// since resolving a changeId to a tree node never needed the webview in the first place.

beforeEach(() => { createQuickPick.mockClear(); showQuickPick.mockClear(); showWarningMessage.mockClear(); showInputBox.mockClear(); });

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
    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: '000001:Fallout4.esm' }, { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(executeCommand).toHaveBeenCalledWith('modbench.openEditor', { formKey: '000001:Fallout4.esm', label: '000001:Fallout4.esm' });
  });

  it('an unrecognized message type is a no-op', async () => {
    const { reveal, refresh, revealFn } = fakeReveal();

    await routeRecordPanelMessage({ type: 'somethingElse' }, { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(executeCommand).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(revealFn).not.toHaveBeenCalled();
  });

  it('a non-object message is a no-op', async () => {
    await expect(routeRecordPanelMessage('not an object', { reveal: undefined, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined })).resolves.toBeUndefined();
    await expect(routeRecordPanelMessage(null, { reveal: undefined, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined })).resolves.toBeUndefined();
  });

  // Issue #174: the new branch — every successful pending-change mutation in the webview
  // posts PENDING_CHANGED, and the tree needs to refresh in response.
  it('PENDING_CHANGED refreshes the pending changes tree provider', async () => {
    const { reveal, refresh } = fakeReveal();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }, { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('PENDING_CHANGED with reveal deps undefined is a no-op, not a throw', async () => {
    await expect(routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }, { reveal: undefined, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined })).resolves.toBeUndefined();
  });

  // Issue #200: the webview has no route to the 'Modbench' channel of its own — LOG is the
  // bridge. The router does no interpretation, just a level→method forward.
  it('LOG at debug level forwards the message to channel.debug', async () => {
    const { reveal } = fakeReveal();
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'debug', message: 'staged edit' }, { reveal, channel, formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(channel.debug).toHaveBeenCalledWith('staged edit');
    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
  });

  it('LOG at info level forwards the message to channel.info', async () => {
    const { reveal } = fakeReveal();
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'info', message: 'saved group' }, { reveal, channel, formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(channel.info).toHaveBeenCalledWith('saved group');
    expect(channel.debug).not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
  });

  it('LOG at warn level forwards the message to channel.warn', async () => {
    const { reveal } = fakeReveal();
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn', message: 'rejected drop' }, { reveal, channel, formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(channel.warn).toHaveBeenCalledWith('rejected drop');
    expect(channel.debug).not.toHaveBeenCalled();
    expect(channel.info).not.toHaveBeenCalled();
  });

  it('LOG with reveal deps undefined still forwards to the channel', async () => {
    const channel = fakeChannel();

    await routeRecordPanelMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level: 'debug', message: 'x' }, { reveal: undefined, channel, formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined });

    expect(channel.debug).toHaveBeenCalledWith('x');
  });
});

// Issue #208: reveal moved off the webview↔extension message bridge entirely — the native
// `modbench.pendingCell.reveal` command calls this function directly with the changeId from
// the merged data-vscode-context object, so it's exercised here as a plain function call
// rather than through routeRecordPanelMessage's dispatch (these are the same four behaviors
// the old REVEAL_PENDING_CHANGE branch covered above, unchanged).
describe('revealPendingChange (issue #208)', () => {
  it('reveals a resolvable change selected/focused/expanded', async () => {
    const node = { id: 'chg-1' } as unknown as PendingTreeNode;
    const { reveal, revealFn } = fakeReveal({ resolveChange: () => Promise.resolve(node) });

    await revealPendingChange('chg-1', reveal);

    expect(revealFn).toHaveBeenCalledWith(node, { select: true, focus: true, expand: true });
  });

  it('a change no longer pending logs and does not reveal', async () => {
    const { reveal, revealFn, log } = fakeReveal({ resolveChange: () => Promise.resolve(undefined) });

    await revealPendingChange('chg-1', reveal);

    expect(revealFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chg-1'));
  });

  it('reports an error (not a throw) when resolution fails', async () => {
    const { reveal, report } = fakeReveal({ resolveChange: () => Promise.reject(new Error('boom')) });

    await expect(revealPendingChange('chg-1', reveal)).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledWith('error', expect.any(String), 'boom');
  });

  it('with reveal deps undefined is a no-op', async () => {
    await expect(revealPendingChange('chg-1', undefined)).resolves.toBeUndefined();
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
    const { reveal } = fakeReveal();
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: [] },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined },
    )).resolves.toBeUndefined();
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('opens a QuickPick and replies with the picked FormKey, correlated by requestId', async () => {
    const { reveal } = fakeReveal();
    const searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const reply = vi.fn();
    const { qp, accept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r1', seed: '', validTypes: ['npc_'] },
      { reveal, channel: fakeChannel(), formKeyPicker: { repository: { searchRecords }, reply }, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined },
    );
    qp.selectedItems = [{ label: 'Picked [X]', formKey: 'X' }];
    accept();
    await dispatchPromise;

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: 'r1', formKey: 'X' });
  });

  it('replies with formKey: null when the picker is dismissed without a selection', async () => {
    const { reveal } = fakeReveal();
    const searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const reply = vi.fn();
    const { qp, hideWithoutAccept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: 'r2', seed: '', validTypes: [] },
      { reveal, channel: fakeChannel(), formKeyPicker: { repository: { searchRecords }, reply }, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined },
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
    const { reveal } = fakeReveal();
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r1', seed: '' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined },
    )).resolves.toBeUndefined();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('opens a QuickPick and replies with the picked function, correlated by requestId', async () => {
    const { reveal } = fakeReveal();
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']);
    const reply = vi.fn();
    showQuickPick.mockResolvedValue('GetDistance');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r1', seed: 'GetIsID' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: { repository: { getConditionFunctions }, reply }, revertGroupConfirm: undefined, addScriptName: undefined },
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED, requestId: 'r1', functionName: 'GetDistance' });
  });

  it('replies with functionName: null when the picker is dismissed without a selection', async () => {
    const { reveal } = fakeReveal();
    const getConditionFunctions = vi.fn().mockResolvedValue(['GetDistance', 'GetIsID']);
    const reply = vi.fn();
    showQuickPick.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId: 'r2', seed: '' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: { repository: { getConditionFunctions }, reply }, revertGroupConfirm: undefined, addScriptName: undefined },
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
    const { reveal } = fakeReveal();
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId: 'r1', detail: 'x' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined },
    )).resolves.toBeUndefined();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows the modal with the given detail and replies with confirmed: true, correlated by requestId', async () => {
    const { reveal } = fakeReveal();
    const reply = vi.fn();
    showWarningMessage.mockResolvedValue('Revert');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId: 'r1', detail: 'Npc / X · Name' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: { reply }, addScriptName: undefined },
    );

    expect(showWarningMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modal: true, detail: 'Npc / X · Name' }), 'Revert');
    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: 'r1', confirmed: true });
  });

  it('replies with confirmed: false when the modal is dismissed', async () => {
    const { reveal } = fakeReveal();
    const reply = vi.fn();
    showWarningMessage.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId: 'r2', detail: 'x' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: { reply }, addScriptName: undefined },
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
    const { reveal } = fakeReveal();
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId: 'r1' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: undefined },
    )).resolves.toBeUndefined();
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('shows the input box and replies with the entered name, correlated by requestId', async () => {
    const { reveal } = fakeReveal();
    const reply = vi.fn();
    showInputBox.mockResolvedValue('MyScript');

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId: 'r1' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: { reply } },
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: 'r1', name: 'MyScript' });
  });

  it('replies with name: null when the input box is dismissed', async () => {
    const { reveal } = fakeReveal();
    const reply = vi.fn();
    showInputBox.mockResolvedValue(undefined);

    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId: 'r2' },
      { reveal, channel: fakeChannel(), formKeyPicker: undefined, conditionFunctionPicker: undefined, revertGroupConfirm: undefined, addScriptName: { reply } },
    );

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED, requestId: 'r2', name: null });
  });
});
