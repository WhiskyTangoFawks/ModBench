import { describe, it, expect } from 'vitest';
import { recordOpenPlan, pinnedArgument } from '../recordOpenPlan';

const A = { formKey: '000801:A.esp' };
const B = { formKey: '000802:A.esp' };
const ofRecord = (record: { formKey: string }, plugin?: { name: string; origin: string }) =>
  ({ argument: { kind: 'record', ...record, plugin } });
const COPY = { name: 'A.esp', origin: 'ModA' };

describe('recordOpenPlan', () => {
  it.each([
    ['a click on one record opens its winning copy as a preview', ofRecord(A), [], { addresses: [A], pinned: false }],
    ['pinned: true opens pinned', { ...ofRecord(A), pinned: true }, [], { addresses: [A], pinned: true }],
    ['records that each ask pinned open pinned, as one grid', [{ ...ofRecord(A), pinned: true }, { ...ofRecord(B), pinned: true }], [],
      { addresses: [A, B], pinned: true }],
    ['several records without pinned open one grid as a preview', [ofRecord(A), ofRecord(B)], [], { addresses: [A, B], pinned: false }],
    ['a row opens its own copy: the plugin and origin its Argument names', { label: 'Gun', ...ofRecord(A, COPY) }, [],
      { addresses: [{ ...A, plugin: COPY }], pinned: false }],
    ['a row that carries no Argument opens nothing', { label: 'Types' }, [], { addresses: [], pinned: false }],
    ['a row whose Argument is not a record opens nothing', { argument: { kind: 'mod', name: 'ModA' } }, [], { addresses: [], pinned: false }],
    ['with no Argument, the records selected in the focused view open as one grid, a preview', undefined, [ofRecord(A, COPY), ofRecord(B)],
      { addresses: [{ ...A, plugin: COPY }, B], pinned: false }],
    ['an Argument that carries only pinned opens the focused view\'s selection, pinned', { pinned: true }, [ofRecord(A, COPY), ofRecord(B)],
      { addresses: [{ ...A, plugin: COPY }, B], pinned: true }],
    ['with no Argument and no record selected, nothing opens', undefined, [{ label: 'Types' }], { addresses: [], pinned: false }],
    ['an Argument wins over the focused view\'s selection', ofRecord(A), [ofRecord(B)], { addresses: [A], pinned: false }],
  ])('%s', (_, argument, selection, plan) => {
    expect(recordOpenPlan(argument, selection)).toEqual(plan);
  });
});

describe('pinnedArgument', () => {
  it('asks to open the whole menu selection pinned', () => {
    expect(pinnedArgument(ofRecord(A), [ofRecord(A), ofRecord(B)])).toEqual([
      { argument: { kind: 'record', ...A }, pinned: true }, { argument: { kind: 'record', ...B }, pinned: true },
    ]);
  });

  it('falls back to the clicked row when the selection is empty', () => {
    expect(pinnedArgument(ofRecord(A), [])).toEqual([{ argument: { kind: 'record', ...A }, pinned: true }]);
  });

  it('reads a tree row by the Argument it carries and skips a row that carries none', () => {
    const row = ofRecord(A, COPY);
    expect(pinnedArgument(row, [row, { label: 'Types' }])).toEqual([
      { argument: { kind: 'record', ...A, plugin: COPY }, pinned: true },
    ]);
  });
});
