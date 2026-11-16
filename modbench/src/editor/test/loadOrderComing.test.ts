import { describe, it, expect } from 'vitest';
import { loadOrderComing } from '../loadOrderComing';
import type { RecordIndexProgress } from '../../client';

const status = (overrides: Partial<RecordIndexProgress>): RecordIndexProgress => ({ done: 0, total: 0, version: 1, settled: false, ...overrides });

const comingFor = (modbenchHasOne: boolean, progress?: RecordIndexProgress) =>
  loadOrderComing({ hasLoadOrderToHand: modbenchHasOne, subscribe: () => ({ dispose: () => undefined }) }, { recordIndexProgress: progress }).now();

describe('whether a load order is on its way to mEdit', () => {
  it.each([
    ['reconciling one', status({})],
    ['rebuilding the index a good read filled', status({ done: 0, total: 3 })],
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
