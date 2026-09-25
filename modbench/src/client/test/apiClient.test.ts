import { describe, it, expect } from 'vitest';
import { createApiClient, errorText, toLoadOrderStatus } from '../apiClient';

describe('createApiClient', () => {
  it('uses the supplied port in the base URL', () => {
    const client = createApiClient(5172);
    // openapi-fetch keeps baseUrl in internal config, so only construction is observable.
    expect(client).toHaveProperty('GET');
    expect(client).toHaveProperty('POST');
  });

  it('constructs different clients for different ports', () => {
    const a = createApiClient(5172);
    const b = createApiClient(5173);
    expect(a).not.toBe(b);
  });
});

// The backend answers every failure as RFC 7807 ProblemDetails; the toast wants the sentence
// written for the user, not the envelope around it ("open in another
// Modbench window" would otherwise arrive inside a JSON blob).
describe('errorText', () => {
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

// ADR-0013: the whole-set conflict sweep leaves a Ready load order with stale winners, so
// anything rendering conflict information must read `conflictsComputed`, never the wire's `state`.
describe('toLoadOrderStatus', () => {
  it('keys indexedPlugins on filename alone, dropping origin', () => {
    const status = toLoadOrderStatus({
      state: 'Reconciling',
      totalPlugins: 3, version: 1,
      indexedPlugins: [{ name: 'Fallout4.esm', origin: 'Data' }, { name: 'TestMod.esp', origin: 'ModA' }],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }],
    });

    expect(status).toEqual({
      totalPlugins: 3, version: 1,
      indexedPlugins: ['Fallout4.esm', 'TestMod.esp'],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', origin: 'SomeMod', reason: 'RACE parse' }],
      holdsNone: false,
    });
    expect(status.refusal).toBeUndefined();
  });

  // A rebuild drops the index before it refills: the one state that says nothing is held, which
  // no other field can tell apart from a reconcile that has indexed nothing yet.
  it('says the index holds none for the None state, and only for it', () => {
    const tick = (state: 'None' | 'Reconciling') => toLoadOrderStatus({
      state, totalPlugins: 0, version: 1, indexedPlugins: [], conflictsComputed: false, failures: [],
    });

    expect(tick('None').holdsNone).toBe(true);
    expect(tick('Reconciling').holdsNone).toBe(false);
  });

  // The wire's `state` survives only as `refusal.kind` (ADR-0009 point 5): a caller tells
  // "another window has this instance open" apart from "the reconcile hit something unknown"
  // only through this field, never by re-deriving it.
  it('carries a heldElsewhere refusal for the HeldElsewhere state', () => {
    const status = toLoadOrderStatus({
      state: 'HeldElsewhere',
      totalPlugins: 0, version: 1,
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
      totalPlugins: 0, version: 1,
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
      totalPlugins: 0, version: 1,
      indexedPlugins: [],
      conflictsComputed: false,
      failures: [],
      message: null,
    });

    expect(status.refusal).toBeUndefined();
  });
});
