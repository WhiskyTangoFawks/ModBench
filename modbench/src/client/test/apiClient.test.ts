import { describe, it, expect } from 'vitest';
import { createApiClient, errorText, toLoadOrderStatus } from '../apiClient';

describe('createApiClient', () => {
  it('constructs different clients for different ports', () => {
    const a = createApiClient(5172);
    const b = createApiClient(5173);
    expect(a).not.toBe(b);
  });
});

describe('errorText, the sentence written for the user rather than the RFC 7807 ProblemDetails envelope the backend answers every failure in', () => {
  it('passes a string body through', () => {
    expect(errorText('bad dir')).toBe('bad dir');
  });

  it('is empty for no body', () => {
    expect(errorText(undefined)).toBe('');
    expect(errorText(null)).toBe('');
  });

  it("prefers a problem's detail, then its title, over the JSON envelope", () => {
    expect(errorText({ type: 'about:blank', title: 'Locked', status: 423, detail: 'held elsewhere' })).toBe('held elsewhere');
    expect(errorText({ title: 'Locked', status: 423 })).toBe('Locked');
  });

  it('falls back to JSON for an object that is not a problem', () => {
    expect(errorText({ form_key: '000801:Fallout4.esm' })).toBe('{"form_key":"000801:Fallout4.esm"}');
  });
});

describe('toLoadOrderStatus', () => {
  it('keeps each indexed plugin as (origin, filename), so two of one filename stay two, and carries conflictsComputed false through a Ready wire state, as the whole-set conflict sweep leaves a Ready load order with stale winners', () => {
    const status = toLoadOrderStatus({
      state: 'Ready',
      totalPlugins: 3, activePlugins: 2, version: 1,
      indexedPlugins: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' }],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }],
    });

    expect(status).toEqual({
      totalPlugins: 3, activePlugins: 2, version: 1,
      indexedPlugins: [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' }],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }],
      holdsNone: false,
    });
    expect(status.refusal).toBeUndefined();
  });

  it('says the index holds none for the None state, and only for it, as a rebuild drops the index before it refills and no other field tells it from a reconcile that has indexed nothing yet', () => {
    const tick = (state: 'None' | 'Reconciling') => toLoadOrderStatus({
      state, totalPlugins: 0, activePlugins: 0, version: 1, indexedPlugins: [], conflictsComputed: false, failures: [],
    });

    expect(tick('None').holdsNone).toBe(true);
    expect(tick('Reconciling').holdsNone).toBe(false);
  });

  it('carries a heldElsewhere refusal for the HeldElsewhere state', () => {
    const status = toLoadOrderStatus({
      state: 'HeldElsewhere',
      totalPlugins: 0, activePlugins: 0, version: 1,
      indexedPlugins: [],
      conflictsComputed: false,
      failures: [],
      message: 'This instance\'s index is open in another Modbench window.',
    });

    expect(status.refusal).toEqual({
      kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.',
    });
  });

  it('carries a failed refusal for the Failed state', () => {
    const status = toLoadOrderStatus({
      state: 'Failed',
      totalPlugins: 0, activePlugins: 0, version: 1,
      indexedPlugins: [],
      conflictsComputed: false,
      failures: [],
      message: 'the reconcile threw something unexpected',
    });

    expect(status.refusal).toEqual({ kind: 'failed', message: 'the reconcile threw something unexpected' });
  });

  it('carries no refusal when a refusal state has no message', () => {
    const status = toLoadOrderStatus({
      state: 'HeldElsewhere',
      totalPlugins: 0, activePlugins: 0, version: 1,
      indexedPlugins: [],
      conflictsComputed: false,
      failures: [],
      message: null,
    });

    expect(status.refusal).toBeUndefined();
  });
});
