import { describe, it, expect } from 'vitest';
import { modsMovePick, separatorsMovePick } from '../movePick';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { groupModOrder } from '../../instanceAdapter/modGroups';

const mod = (name: string): ModlistEntry => ({ kind: 'mod', name, enabled: true });
const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST = groupModOrder([
  mod('Alpha'), separator('Early'), mod('Beta'), separator('Middle'), separator('Late'), mod('Gamma'),
]);

describe('the move pick for mods', () => {
  it.each([
    ['losingAtTop', ['Ungrouped', 'Late', 'Middle', 'Early']],
    ['winningAtTop', ['Ungrouped', 'Early', 'Middle', 'Late']],
  ] as const)('offers Ungrouped, then each separator as the view shows them with %s', (direction, labels) => {
    expect(modsMovePick(ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST, direction, ['Beta']).map((i) => i.label)).toEqual(labels);
  });

  it('marks each place that holds a selected mod as current, and no other', () => {
    const items = modsMovePick(ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST, 'losingAtTop', ['Alpha', 'Gamma']);

    expect(items.map((i) => [i.label, i.description])).toEqual([
      ['Ungrouped', 'current'], ['Late', undefined], ['Middle', undefined], ['Early', 'current'],
    ]);
  });

  it('each item carries the place the mods land in', () => {
    const items = modsMovePick(ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST, 'losingAtTop', ['Beta']);

    expect(items.map((i) => i.target)).toEqual([
      { kind: 'ungrouped' },
      { kind: 'separator', name: 'Late' },
      { kind: 'separator', name: 'Middle' },
      { kind: 'separator', name: 'Early' },
    ]);
  });
});

describe('the move pick for separators', () => {
  it.each([
    ['losingAtTop', ['Late', 'Early']],
    ['winningAtTop', ['Early', 'Late']],
  ] as const)('offers the other separators as the view shows them with %s', (direction, labels) => {
    expect(separatorsMovePick(ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST, direction, ['Middle']).map((i) => i.label)).toEqual(labels);
  });

  it('leaves out every selected separator, and each item carries the separator it lands above', () => {
    const items = separatorsMovePick(ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST, 'losingAtTop', ['Late', 'Early']);

    expect(items).toEqual([{ label: 'Middle', target: { kind: 'separator', name: 'Middle' } }]);
  });
});
