import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createQuickPick = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
  window: { createQuickPick: (...args: unknown[]) => createQuickPick(...args) },
}));

import { pickRecord, type RecordPickerDeps } from '../recordPicker';
import type { RecordSummary } from '../../client';

beforeEach(() => { createQuickPick.mockReset(); });

function makeRecord(i: number, editorId: string | null = `Record${i}`): RecordSummary {
  return {
    formKey: `Fallout4.esm:${String(i).padStart(6, '0')}`, plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: true, editorId,
    origin: 'Data',
    workingTreeState: 'None',
    hasContainerChildren: false,
  hasParseFailure: false,
  };
}

function makeFakeQuickPick() {
  const changeValueListeners: Array<(v: string) => void> = [];
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    value: '',
    placeholder: undefined as string | undefined,
    title: undefined as string | undefined,
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
    typeValue: (v: string) => { qp.value = v; changeValueListeners.forEach(cb => cb(v)); },
    accept: () => { acceptListeners.forEach(cb => cb()); },
    hideWithoutAccept: () => { hideListeners.forEach(cb => cb()); },
  };
}

describe('pickRecord', () => {
  function openPicker(seed: string, validTypes: string[], deps: RecordPickerDeps): Promise<string | null> {
    return pickRecord(deps, seed, validTypes);
  }

  function fakeDeps(searchRecords = vi.fn().mockResolvedValue({ items: [], total: 0 })) {
    const shownOnSurface = vi.fn();
    const deps: RecordPickerDeps = { meditClient: { searchRecords }, reporter: { shownOnSurface } };
    return { deps, searchRecords, shownOnSurface };
  }

  afterEach(() => { vi.useRealTimers(); });

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
    expect(qp.activeItems).toEqual([{ label: `Seeded [${record.formKey}]`, formKey: record.formKey }]);

    qp.hide();
    await dispatchPromise;
  });

  it.each([
    ['searches on the bracketed FormKey when a whole composite label is pasted', 'DogmeatRace [000019:Fallout4.esm]', '000019:Fallout4.esm'],
    ['lets the FormKey win when the label and the bracketed FormKey disagree', 'WrongName [000019:Fallout4.esm]', '000019:Fallout4.esm'],
    ['takes the first bracketed segment, so a VMAD alias suffix does not win over the FormKey', 'SomeNPC [000123:Foo.esp] [2]', '000123:Foo.esp'],
    ['trims whitespace inside the brackets', 'DogmeatRace [ 000019:Fallout4.esm ]', '000019:Fallout4.esm'],
    ['passes an unbracketed name through untouched', 'Dogmeat', 'Dogmeat'],
    ['passes an unbracketed FormKey through untouched', '000019:Fallout4.esm', '000019:Fallout4.esm'],
    ['falls back to the query as typed when the brackets are empty', 'Foo []', 'Foo []'],
    ['falls back to the query as typed when the brackets hold only space', 'Foo [  ]', 'Foo [  ]'],
    ['passes an unclosed bracket through as typed', 'Foo [000019', 'Foo [000019'],
  ])('seeded with a label that %s', async (_label, seed, searched) => {
    const { deps, searchRecords } = fakeDeps();
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker(seed, [], deps);
    await vi.waitFor(() => expect(searchRecords).toHaveBeenCalledWith(searched, []));

    qp.hide();
    await dispatchPromise;
  });

  it('titles a cut list with how many it shows of how many match', async () => {
    const shown = Array.from({ length: 20 }, (_, i) => makeRecord(i));
    const { deps } = fakeDeps(vi.fn().mockResolvedValue({ items: shown, total: 1234 }));
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('Record', [], deps);
    await vi.waitFor(() => expect(qp.items).toHaveLength(20));

    expect(qp.title).toBe('20 of 1,234');

    qp.hide();
    await dispatchPromise;
  });

  it('drops the count when a later search is not cut', async () => {
    vi.useFakeTimers();
    const searchRecords = vi.fn()
      .mockResolvedValueOnce({ items: [makeRecord(1), makeRecord(2)], total: 5 })
      .mockResolvedValueOnce({ items: [makeRecord(1)], total: 1 });
    const { deps } = fakeDeps(searchRecords);
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('Record', [], deps);
    await vi.waitFor(() => expect(qp.title).toBe('2 of 5'));
    typeValue('Record1');
    await vi.advanceTimersByTimeAsync(200);

    expect(qp.items).toHaveLength(1);
    expect(qp.title).toBeUndefined();

    qp.hide();
    await dispatchPromise;
  });

  it('drops the count when the query is emptied', async () => {
    const { deps } = fakeDeps(vi.fn().mockResolvedValue({ items: [makeRecord(1)], total: 5 }));
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('Record', [], deps);
    await vi.waitFor(() => expect(qp.title).toBe('1 of 5'));
    typeValue('');

    expect(qp.title).toBeUndefined();

    qp.hide();
    await dispatchPromise;
  });

  it('drops the count when a later search fails', async () => {
    vi.useFakeTimers();
    const searchRecords = vi.fn()
      .mockResolvedValueOnce({ items: [makeRecord(1)], total: 5 })
      .mockRejectedValueOnce(new Error('mEdit is down'));
    const { deps } = fakeDeps(searchRecords);
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('Record', [], deps);
    await vi.waitFor(() => expect(qp.title).toBe('1 of 5'));
    typeValue('Record1');
    await vi.advanceTimersByTimeAsync(200);

    expect(qp.items).toEqual([expect.objectContaining({ label: '$(error) The search failed' })]);
    expect(qp.title).toBeUndefined();

    qp.hide();
    await dispatchPromise;
  });

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
    searchRecords.mockClear();

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

    const secondRecord = makeRecord(9, 'Second');
    resolveSecond({ items: [secondRecord], total: 1 });
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));
    resolveFirst({ items: [makeRecord(1, 'First')], total: 1 });
    await Promise.resolve();

    expect(qp.items).toEqual([{ label: `Second [${secondRecord.formKey}]`, formKey: secondRecord.formKey }]);

    qp.hide();
    await dispatchPromise;
  });

  it('resolves to the picked FormKey, hiding and disposing the QuickPick', async () => {
    const { deps } = fakeDeps();
    const { qp, accept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', ['npc_'], deps);
    qp.selectedItems = [{ label: 'Picked [X]', formKey: 'X' }];
    accept();

    await expect(dispatchPromise).resolves.toBe('X');
    expect(qp.hide).toHaveBeenCalled();
    expect(qp.dispose).toHaveBeenCalled();
  });

  it('resolves to null and disposes the picker when dismissed without a selection', async () => {
    const { deps } = fakeDeps();
    const { qp, hideWithoutAccept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const dispatchPromise = openPicker('', [], deps);
    hideWithoutAccept();

    await expect(dispatchPromise).resolves.toBeNull();
    expect(qp.dispose).toHaveBeenCalled();
  });

  it('says a failed search in the picker itself and logs it, without picking anything', async () => {
    const { deps, shownOnSurface } = fakeDeps(vi.fn().mockRejectedValue(new Error('connection refused')));
    const { qp } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const result = openPicker('sword', [], deps);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));

    expect(qp.items).toEqual([expect.objectContaining({ label: '$(error) The search failed', detail: 'connection refused' })]);
    expect(shownOnSurface).toHaveBeenCalledWith('error', 'The record search failed.', 'connection refused');
    expect(qp.busy).toBe(false);

    qp.hide();
    await result;
  });

  it('keeps the picker open when the failure row is accepted', async () => {
    const { deps } = fakeDeps(vi.fn().mockRejectedValue(new Error('boom')));
    const { qp, accept } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const result = openPicker('sword', [], deps);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));
    qp.selectedItems = qp.items;
    accept();

    expect(qp.hide).not.toHaveBeenCalled();

    qp.hide();
    await expect(result).resolves.toBeNull();
  });

  it('a later successful search replaces the failure row', async () => {
    const record = makeRecord(3, 'Sword');
    const search = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: [record], total: 1 });
    const { deps } = fakeDeps(search);
    const { qp, typeValue } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);

    const result = openPicker('sw', [], deps);
    await vi.waitFor(() => expect(qp.items).toHaveLength(1));
    vi.useFakeTimers();
    typeValue('swo');
    await vi.advanceTimersByTimeAsync(200);

    expect(qp.items).toEqual([{ label: `Sword [${record.formKey}]`, formKey: record.formKey }]);

    qp.hide();
    await result;
  });
});
