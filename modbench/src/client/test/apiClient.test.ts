import { describe, it, expect } from 'vitest';
import { errorText, toLoadOrderStatus } from '../apiClient';

describe('errorText, the sentence written for the user rather than the RFC 7807 ProblemDetails envelope the backend answers every failure in', () => {
  it.each([
    ['a string body, passed through', 'bad dir', 'bad dir'],
    ['no body, as empty', undefined, ''],
    ['a null body, as empty', null, ''],
    ['a problem, by its detail', { type: 'about:blank', title: 'Locked', status: 423, detail: 'held elsewhere' }, 'held elsewhere'],
    ['a problem with no detail, by its title', { title: 'Locked', status: 423 }, 'Locked'],
    ['an object that is not a problem, as JSON', { form_key: '000801:Fallout4.esm' }, '{"form_key":"000801:Fallout4.esm"}'],
  ])('writes %s', (_, body, text) => {
    expect(errorText(body)).toBe(text);
  });
});

describe('toLoadOrderStatus', () => {
  const wire = { totalPlugins: 0, activePlugins: 0, version: 1, indexedPlugins: [], conflictsComputed: false, failures: [] };

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

  it.each([
    ['None', true],
    ['Reconciling', false],
  ] as const)('says whether the record index holds none for the %s state, as a rebuild drops the record index before it refills and no other field tells it from a reconcile that has indexed nothing yet', (state, holdsNone) => {
    expect(toLoadOrderStatus({ ...wire, state }).holdsNone).toBe(holdsNone);
  });

  it.each([
    ['HeldElsewhere', 'This instance\'s index is open in another Modbench window.',
      { kind: 'heldElsewhere', message: 'This instance\'s index is open in another Modbench window.' }],
    ['Failed', 'the reconcile threw something unexpected', { kind: 'failed', message: 'the reconcile threw something unexpected' }],
    ['HeldElsewhere', null, undefined],
  ] as const)('carries the %s state with the message %j as the refusal %j', (state, message, refusal) => {
    expect(toLoadOrderStatus({ ...wire, state, message }).refusal).toEqual(refusal);
  });
});
