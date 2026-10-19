import { describe, it, expect } from 'vitest';
import { loadOrderComing } from '../loadOrderComing';
import type { LoadOrderStatus } from '../../client/apiClient';

const status = (overrides: Partial<LoadOrderStatus>): LoadOrderStatus => ({
  totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], version: 1, holdsNone: false, ...overrides,
});

const comingFor = (modbenchHasOne: boolean, loadOrderStatus?: LoadOrderStatus) =>
  loadOrderComing({ now: () => modbenchHasOne, onChanged: () => ({ dispose: () => undefined }) }, { loadOrderStatus }).now();

describe('whether a load order is on its way to mEdit', () => {
  it.each([
    ['reconciling one', status({})],
    ['rebuilding the index a good read filled', status({ holdsNone: true })],
  ])('is yes while mEdit is %s, whatever Modbench holds', (_name, reported) => {
    expect(comingFor(false, reported)).toBe(true);
  });

  it.each([
    ['held elsewhere', { kind: 'heldElsewhere' as const, message: 'Another window holds it.' }],
    ['failed', { kind: 'failed' as const, message: 'The reconcile failed.' }],
  ])('is no once mEdit reports the load order %s, whatever Modbench holds', (_name, refusal) => {
    expect(comingFor(true, status({ refusal }))).toBe(false);
  });

  it.each([[true], [false]])('follows Modbench before mEdit reports any: has one to hand is %s', (has) => {
    expect(comingFor(has)).toBe(has);
  });
});
