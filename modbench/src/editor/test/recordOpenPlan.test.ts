import { describe, it, expect } from 'vitest';
import { recordOpenPlan, besideArgument } from '../recordOpenPlan';

const A = { formKey: '000801:A.esp' };
const B = { formKey: '000802:A.esp' };
const ofRecord = (record: { formKey: string }, plugin?: { name: string; origin: string }) =>
  ({ argument: { kind: 'record', ...record, plugin } });
const COPY = { name: 'A.esp', origin: 'ModA' };

describe('recordOpenPlan', () => {
  it('a click on one record opens it as a preview', () => {
    expect(recordOpenPlan(ofRecord(A), [])).toEqual({ addresses: [{ ...A }], placement: 'active', preview: true });
  });

  it('placement: beside opens pinned and beside', () => {
    expect(recordOpenPlan({ ...ofRecord(A), placement: 'beside' }, []))
      .toEqual({ addresses: [A], placement: 'beside', preview: false });
  });

  it('records that each ask beside open beside, each record on its own', () => {
    expect(recordOpenPlan([{ ...ofRecord(A), placement: 'beside' }, { ...ofRecord(B), placement: 'beside' }], []))
      .toEqual({ addresses: [A, B], placement: 'beside', preview: false });
  });

  it('records that each name a tab\'s place open in it', () => {
    const place = { document: 'modbench-rendered:/Data/A.esp/Gun.json', viewColumn: 2 };
    expect(recordOpenPlan([{ ...ofRecord(A), placement: place }, { ...ofRecord(B), placement: place }], []))
      .toEqual({ addresses: [A, B], placement: place, preview: false });
  });

  it('several records without a placement each open pinned', () => {
    expect(recordOpenPlan([ofRecord(A), ofRecord(B)], [])).toEqual({ addresses: [A, B], placement: 'active', preview: false });
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

  it('with no Argument, opens the records selected in the focused view, each pinned in a tab of its own', () => {
    expect(recordOpenPlan(undefined, [ofRecord(A, COPY), ofRecord(B)]))
      .toEqual({ addresses: [{ ...A, plugin: COPY }, B], placement: 'active', preview: false });
  });

  it('with no Argument and no record selected, opens nothing', () => {
    expect(recordOpenPlan(undefined, [{ label: 'Types' }]).addresses).toEqual([]);
  });

  it('an Argument wins over the focused view\'s selection', () => {
    expect(recordOpenPlan(ofRecord(A), [ofRecord(B)]).addresses).toEqual([A]);
  });
});

describe('besideArgument', () => {
  it('asks to open the whole menu selection beside', () => {
    expect(besideArgument(ofRecord(A), [ofRecord(A), ofRecord(B)])).toEqual([
      { argument: { kind: 'record', ...A }, placement: 'beside' }, { argument: { kind: 'record', ...B }, placement: 'beside' },
    ]);
  });

  it('falls back to the clicked row when the selection is empty', () => {
    expect(besideArgument(ofRecord(A), [])).toEqual([{ argument: { kind: 'record', ...A }, placement: 'beside' }]);
  });

  it('reads a tree row by the Argument it carries and skips a row that carries none', () => {
    const row = ofRecord(A, COPY);
    expect(besideArgument(row, [row, { label: 'Types' }])).toEqual([
      { argument: { kind: 'record', ...A, plugin: COPY }, placement: 'beside' },
    ]);
  });
});
