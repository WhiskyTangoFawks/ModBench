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

import {
  routeRecordPanelMessage, pickFormKeyViaQuickPick, normalizeFormKeyQuery,
  type FormKeyPickerDeps, type RouteRecordPanelMessageDeps,
} from '../recordPanelMessageRouter';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from '../../medit/messages';
import type { RecordSummary } from '../../medit/client';
import { InMemoryMEditClient } from '../../medit/client';

beforeEach(() => { createQuickPick.mockClear(); showQuickPick.mockClear(); });

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}
const fakeReporter = { report: vi.fn(), landed: vi.fn() };

// The router's one client covers both editField and the picker's search — rebuilt fresh here so
// each test starts with `editRecord` answering `{ applied: true }`.
let meditClient: InMemoryMEditClient;
const onRecordEdited = vi.fn();

beforeEach(() => {
  meditClient = new InMemoryMEditClient();
  meditClient.setCommandResult('editRecord', { applied: true });
});

function editRecordCalls() {
  return meditClient.calls.filter(c => c.method === 'editRecord');
}

function makeDeps(overrides: Partial<RouteRecordPanelMessageDeps> = {}): RouteRecordPanelMessageDeps {
  return {
    channel: fakeChannel(), reporter: fakeReporter,
    meditClient, onRecordEdited,
    // Undefined by default: a message arriving with no deps wired is a no-op, not a crash.
    formKeyPicker: undefined,
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
    typeValue(v: string) { qp.value = v; changeValueListeners.forEach(cb => cb(v)); },
    accept() { acceptListeners.forEach(cb => cb()); },
    hideWithoutAccept() { hideListeners.forEach(cb => cb()); },
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

  // Correctly discriminated (a real EDIT_FIELD), but formKey is the wrong type — parseWebviewToExtension's
  // required-field check, not its discriminant switch.
  it('a correctly-discriminated message with a malformed payload is also a no-op', async () => {
    await expect(routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: 123, plugin: 'Mod.esp', origin: 'SomeMod', envelope: { op: 'set', path: [] } },
      makeDeps(),
    )).resolves.toBeUndefined();

    expect(editRecordCalls()).toEqual([]);
  });
});

// The router carries no panel identity, so "two panels" is two independently-built deps bundles.
// No PASTE message exists to route: Ctrl+V lands in a plain <input> (ADR-0018) and committing it
// is the ordinary EDIT_FIELD write.
describe('cross-panel copy/paste — two independently-opened panels share this router unmodified', () => {
  beforeEach(() => {
    writeText.mockReset();
    onRecordEdited.mockReset();
  });

  it('copies a value out of one panel and commits it, via ordinary EDIT_FIELD, into a different panel\'s own record', async () => {
    const panelADeps = makeDeps(); // "panel A", open on Record1
    const panelBDeps = makeDeps(); // "panel B", open on a different record — its own independent deps bundle

    // Ctrl+C in panel A: the webview has already read the focused cell's model value (ADR-0018);
    // this is that value on its way to the OS clipboard.
    await routeRecordPanelMessage(
      { type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value: 'CopiedNPC [000001:Fallout4.esm]' }, panelADeps);
    expect(writeText).toHaveBeenCalledWith('CopiedNPC [000001:Fallout4.esm]');

    // Ctrl+V in panel B: nothing Modbench-side carries the paste, so all that is left to prove is
    // that the commit is addressed to panel B's record, not panel A's.
    await routeRecordPanelMessage({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000800:Mod.esp', plugin: 'Mod.esp', origin: 'SomeMod',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'LinkedRef' }], value: 'CopiedNPC [000001:Fallout4.esm]' },
    }, panelBDeps);

    expect(editRecordCalls()).toEqual([{
      method: 'editRecord',
      args: [
        '000800:Mod.esp', 'Mod.esp', 'SomeMod',
        { op: 'set', path: [{ kind: 'member', name: 'LinkedRef' }], value: 'CopiedNPC [000001:Fallout4.esm]' },
      ],
    }]);
    expect(onRecordEdited).toHaveBeenCalledWith('000800:Mod.esp', 'Mod.esp', 'SomeMod');
    // Copying out of panel A triggers no write of its own — only panel B's later EDIT_FIELD does.
  });
});

// ADR-0007: the one write the panel can ask for. Routed through the host rather than posted
// to the backend from the webview precisely so a refusal can become a native notification — which
// is what these cases are really pinning.
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

  beforeEach(() => {
    fakeReporter.report.mockReset();
    onRecordEdited.mockReset();
  });

  it('sends the edit through the single write path with its compound plugin identity', async () => {
    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(editRecordCalls()[0]!.args).toEqual(['000800:Mod.esp', 'Mod.esp', 'SomeMod', envelope]);
  });

  // The webview spells the whole write; the host adds nothing and rebuilds nothing, so an op with
  // no value and a path of several hops reaches the port exactly as posted.
  it('passes an add envelope with a nested key path through verbatim, value and all', async () => {
    const add = {
      op: 'add' as const,
      path: [
        { kind: 'member' as const, name: 'VirtualMachineAdapter' },
        { kind: 'member' as const, name: 'Scripts' },
        { kind: 'key' as const, key: 'Guard' },
        { kind: 'member' as const, name: 'Properties' },
      ],
    };
    await routeRecordPanelMessage({ ...editMessage, envelope: add }, makeDeps());

    expect(editRecordCalls()[0]!.args).toEqual(['000800:Mod.esp', 'Mod.esp', 'SomeMod', add]);
    expect(editRecordCalls()[0]!.args[3]).not.toHaveProperty('value');
  });

  it('tells the panel to re-read once the edit has landed', async () => {
    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(onRecordEdited).toHaveBeenCalledWith('000800:Mod.esp', 'Mod.esp', 'SomeMod');
    expect(fakeReporter.report).not.toHaveBeenCalled();
  });

  it('surfaces a refusal with the message that names the way out, and does not re-read', async () => {
    meditClient.setCommandResult('editRecord', {
      applied: false,
      refusal: 'PluginNotTracked',
      message: 'Mod.esp is not tracked, so it is read-only. Run "Modbench: Track\u2026" on it once to start editing.',
    });

    await routeRecordPanelMessage(editMessage, makeDeps());

    // Relayed verbatim: re-wording the backend's message here would put that text in two places
    // with only one of them tested. Whole string, so a partial relay fails.
    expect(fakeReporter.report).toHaveBeenCalledWith(
      'warning',
      'Mod.esp is not tracked, so it is read-only. Run "Modbench: Track\u2026" on it once to start editing.');
    expect(onRecordEdited).not.toHaveBeenCalled();
  });

  it('a refusal is a warning, not an error — the user got a clear answer with a next step', async () => {
    meditClient.setCommandResult('editRecord', {
      applied: false, refusal: 'PluginHasNoModFolder', message: 'Author a patch plugin and edit the override there.',
    });

    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(fakeReporter.report.mock.calls[0]![0]).toBe('warning');
  });

  it('a transport failure is an error — nothing answered at all', async () => {
    meditClient.setCommandFailure('editRecord', new Error('ECONNREFUSED'));

    await routeRecordPanelMessage(editMessage, makeDeps());

    expect(fakeReporter.report).toHaveBeenCalledWith('error', expect.any(String), 'ECONNREFUSED');
    expect(onRecordEdited).not.toHaveBeenCalled();
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

// The FormKey picker as a native QuickPick — the extension-host half
// of the bridge pickFormKey (webview/src/nativeBridge.ts) talks to. Exercised directly here,
// separately from routeRecordPanelMessage's dispatch.
describe('pickFormKeyViaQuickPick', () => {
  function fakeDeps(searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 })): { deps: FormKeyPickerDeps; searchRecords: typeof searchRecords; reply: ReturnType<typeof vi.fn> } {
    const reply = vi.fn();
    return { deps: { meditClient: { searchRecords }, reply }, searchRecords, reply };
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

  // The seed is the composite the cell displays, not the bare FormKey. Search already normalizes
  // it; pre-selection must too, or comparing the raw seed against item.formKey stops matching.
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

  // Pasting a whole "EditorID [FormKey]" label copied from a cell searches on the FormKey, not
  // on the literal — the normalizer's one wiring point.
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

describe('routeRecordPanelMessage — OPEN_FORM_KEY_PICKER', () => {
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
      makeDeps({ formKeyPicker: { meditClient: { searchRecords }, reply } }),
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
      makeDeps({ formKeyPicker: { meditClient: { searchRecords }, reply } }),
    );
    hideWithoutAccept();
    await dispatchPromise;

    expect(reply).toHaveBeenCalledWith({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: 'r2', formKey: null });
  });
});
