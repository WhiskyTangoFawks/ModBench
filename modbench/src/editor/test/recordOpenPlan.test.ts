import { describe, it, expect } from 'vitest';
import { recordOpenPlan, pinnedArgument } from '../recordOpenPlan';

const A = { formKey: '000801:A.esp' };
const B = { formKey: '000802:A.esp' };
const ofRecord = (record: { formKey: string }, plugin?: { name: string; origin: string }) =>
  ({ argument: { kind: 'record', ...record, plugin } });
const COPY = { name: 'A.esp', origin: 'ModA' };

describe('recordOpenPlan', () => {
  it('a click on one record opens it as a preview', () => {
    expect(recordOpenPlan(ofRecord(A), [])).toEqual({ addresses: [{ ...A }], pinned: false });
  });

  it('pinned: true opens pinned', () => {
    expect(recordOpenPlan({ ...ofRecord(A), pinned: true }, []))
      .toEqual({ addresses: [A], pinned: true });
  });

  it('records that each ask pinned open pinned, as one grid', () => {
    expect(recordOpenPlan([{ ...ofRecord(A), pinned: true }, { ...ofRecord(B), pinned: true }], []))
      .toEqual({ addresses: [A, B], pinned: true });
  });

  it('several records without pinned open one grid as a preview', () => {
    expect(recordOpenPlan([ofRecord(A), ofRecord(B)], [])).toEqual({ addresses: [A, B], pinned: false });
  });

  it('reads a row as its own copy: the plugin and origin its Argument names', () => {
    expect(recordOpenPlan({ label: 'Gun', ...ofRecord(A, COPY) }, []).addresses).toEqual([{ ...A, plugin: COPY }]);
  });

  it('reads a record that names no plugin as its winning copy', () => {
    expect(recordOpenPlan(ofRecord(A), []).addresses).toEqual([A]);
  });

  it('skips a row that carries no record Argument', () => {
    expect(recordOpenPlan({ label: 'Types' }, []).addresses).toEqual([]);
    expect(recordOpenPlan({ argument: { kind: 'mod', name: 'ModA' } }, []).addresses).toEqual([]);
  });

  it('with no Argument, opens the records selected in the focused view, as one grid, a preview', () => {
    expect(recordOpenPlan(undefined, [ofRecord(A, COPY), ofRecord(B)]))
      .toEqual({ addresses: [{ ...A, plugin: COPY }, B], pinned: false });
  });

  it('an Argument that carries only pinned opens the focused view\'s selection, pinned', () => {
    expect(recordOpenPlan({ pinned: true }, [ofRecord(A, COPY), ofRecord(B)]))
      .toEqual({ addresses: [{ ...A, plugin: COPY }, B], pinned: true });
  });

  it('with no Argument and no record selected, opens nothing', () => {
    expect(recordOpenPlan(undefined, [{ label: 'Types' }]).addresses).toEqual([]);
  });

  it('an Argument wins over the focused view\'s selection', () => {
    expect(recordOpenPlan(ofRecord(A), [ofRecord(B)]).addresses).toEqual([A]);
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
