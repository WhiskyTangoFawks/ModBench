import { describe, it, expect } from 'vitest';
import { modsMovePick, separatorsMovePick } from '../movePick';
import type { ModlistEntry } from '../../instanceLoader/instance';

const mod = (name: string): ModlistEntry => ({ kind: 'mod', name, enabled: true });
const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

// modlist.txt order, winning first: Early holds Alpha, Middle holds Beta, Late holds nothing, and
// Gamma is ungrouped.
const ENTRIES: readonly ModlistEntry[] = [
  mod('Alpha'), separator('Early'), mod('Beta'), separator('Middle'), separator('Late'), mod('Gamma'),
];

describe('the move pick for mods', () => {
  it('offers Ungrouped, then each separator as the view shows them with losing at the top', () => {
    const items = modsMovePick(ENTRIES, 'losingAtTop', ['Beta']);

    expect(items.map((i) => i.label)).toEqual(['Ungrouped', 'Late', 'Middle', 'Early']);
  });

  it('offers Ungrouped, then each separator as the view shows them with winning at the top', () => {
    const items = modsMovePick(ENTRIES, 'winningAtTop', ['Beta']);

    expect(items.map((i) => i.label)).toEqual(['Ungrouped', 'Early', 'Middle', 'Late']);
  });

  it('marks each place that holds a selected mod as current, and no other', () => {
    const items = modsMovePick(ENTRIES, 'losingAtTop', ['Alpha', 'Gamma']);

    expect(items.map((i) => [i.label, i.description])).toEqual([
      ['Ungrouped', 'current'], ['Late', undefined], ['Middle', undefined], ['Early', 'current'],
    ]);
  });

  it('each item carries the place the mods land in', () => {
    const items = modsMovePick(ENTRIES, 'losingAtTop', ['Beta']);

    expect(items.map((i) => i.target)).toEqual([
      { kind: 'ungrouped' },
      { kind: 'separator', name: 'Late' },
      { kind: 'separator', name: 'Middle' },
      { kind: 'separator', name: 'Early' },
    ]);
  });
});

describe('the move pick for separators', () => {
  it('offers the other separators as the view shows them, in either direction', () => {
    expect(separatorsMovePick(ENTRIES, 'losingAtTop', ['Middle']).map((i) => i.label)).toEqual(['Late', 'Early']);
    expect(separatorsMovePick(ENTRIES, 'winningAtTop', ['Middle']).map((i) => i.label)).toEqual(['Early', 'Late']);
  });

  it('leaves out every selected separator, and each item carries the separator it lands above', () => {
    const items = separatorsMovePick(ENTRIES, 'losingAtTop', ['Late', 'Early']);

    expect(items).toEqual([{ label: 'Middle', target: 'Middle' }]);
  });
});
