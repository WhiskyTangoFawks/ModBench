import { describe, it, expect } from 'vitest';
import { recordOpenPlan, besideArgument } from '../recordOpenPlan';

const A = { formKey: '000801:A.esp' };
const B = { formKey: '000802:A.esp' };

describe('recordOpenPlan', () => {
  it('a click on one record opens it as a preview', () => {
    expect(recordOpenPlan(A, [])).toEqual({ addresses: [A], beside: false, preview: true });
  });

  it('placement: beside opens pinned and beside', () => {
    expect(recordOpenPlan({ ...A, placement: 'beside' }, []))
      .toEqual({ addresses: [A], beside: true, preview: false });
  });

  it('records that each ask beside open beside, each record on its own', () => {
    expect(recordOpenPlan([{ ...A, placement: 'beside' }, { ...B, placement: 'beside' }], []))
      .toEqual({ addresses: [A, B], beside: true, preview: false });
  });

  it('several records without a placement each open pinned', () => {
    expect(recordOpenPlan([A, B], [])).toEqual({ addresses: [A, B], beside: false, preview: false });
  });

  it('reads a tree row by the FormKey it states', () => {
    const row = { kind: 'record', label: 'Gun', record: { formKey: A.formKey } };
    expect(recordOpenPlan(row, []).addresses).toEqual([A]);
  });

  it.each(['worldspace', 'cell', 'placed'])('reads a %s row by its own FormKey', (kind) => {
    expect(recordOpenPlan({ kind, formKey: A.formKey }, []).addresses).toEqual([A]);
  });

  it('reads a Plugin Header record by its plugin\'s address', () => {
    const header = { header: { name: 'A.esp', origin: 'ModA' } };
    expect(recordOpenPlan(header, []).addresses).toEqual([header]);
    expect(recordOpenPlan({ ...header, placement: 'beside' }, [])).toEqual({ addresses: [header], beside: true, preview: false });
  });

  it('skips a row that states no record', () => {
    expect(recordOpenPlan({ kind: 'recordType' }, []).addresses).toEqual([]);
  });

  it('with no Argument, opens the records selected in the focused view, each pinned in a tab of its own', () => {
    const rows = [{ kind: 'record', record: { formKey: A.formKey } }, { kind: 'placed', formKey: B.formKey }];
    expect(recordOpenPlan(undefined, rows)).toEqual({ addresses: [A, B], beside: false, preview: false });
  });

  it('with no Argument and no record selected, opens nothing', () => {
    expect(recordOpenPlan(undefined, [{ kind: 'recordType' }]).addresses).toEqual([]);
  });

  it('an Argument wins over the focused view\'s selection', () => {
    expect(recordOpenPlan(A, [B]).addresses).toEqual([A]);
  });
});

describe('besideArgument', () => {
  it('asks to open the whole menu selection beside', () => {
    expect(besideArgument(A, [A, B])).toEqual([{ ...A, placement: 'beside' }, { ...B, placement: 'beside' }]);
  });

  it('falls back to the clicked row when the selection is empty', () => {
    expect(besideArgument(A, [])).toEqual([{ ...A, placement: 'beside' }]);
  });

  it('reads a tree row by the FormKey it states and skips a row that states none', () => {
    const row = { kind: 'record', record: { formKey: A.formKey } };
    expect(besideArgument(row, [row, { kind: 'recordType' }])).toEqual([{ ...A, placement: 'beside' }]);
  });
});
