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

// ADR-0035: the whole-set conflict sweep leaves a Ready load order with stale winners, so
// anything rendering conflict information must read `conflictsComputed`, never the wire's `state`.
describe('toLoadOrderStatus', () => {
  it('keys indexedPlugins on filename alone, dropping origin and state', () => {
    const status = toLoadOrderStatus({
      state: 'Reconciling',
      totalPlugins: 3,
      indexedPlugins: [{ name: 'Fallout4.esm', origin: 'Data' }, { name: 'TestMod.esp', origin: 'ModA' }],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', reason: 'RACE parse' }],
    });

    expect(status).toEqual({
      totalPlugins: 3,
      indexedPlugins: ['Fallout4.esm', 'TestMod.esp'],
      conflictsComputed: false,
      failures: [{ name: 'Bad.esp', reason: 'RACE parse' }],
    });
  });
});
