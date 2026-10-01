import { describe, it, expect } from 'vitest';
import { recordOpenPlan } from '../recordOpenPlan';

const A = { formKey: '000801:A.esp' };
const B = { formKey: '000802:A.esp' };

describe('recordOpenPlan', () => {
  it('a click on one record opens it as a preview', () => {
    expect(recordOpenPlan(A, undefined)).toEqual({ addresses: [A], beside: false, preview: true });
  });

  it('placement: beside opens pinned and beside', () => {
    expect(recordOpenPlan({ ...A, placement: 'beside' }, undefined))
      .toEqual({ addresses: [A], beside: true, preview: false });
  });

  it('a menu invocation opens the whole selection beside, each record on its own', () => {
    expect(recordOpenPlan(A, [A, B])).toEqual({ addresses: [A, B], beside: true, preview: false });
  });

  it('several records without a placement each open pinned', () => {
    expect(recordOpenPlan([A, B], undefined)).toEqual({ addresses: [A, B], beside: false, preview: false });
  });

  it('reads a tree row by the FormKey it states', () => {
    const row = { kind: 'record', label: 'Gun', record: { formKey: A.formKey } };
    expect(recordOpenPlan(row, [row]).addresses).toEqual([A]);
  });

  it.each(['worldspace', 'cell', 'placed'])('reads a %s row by its own FormKey', (kind) => {
    expect(recordOpenPlan({ kind, formKey: A.formKey }, [{ kind, formKey: A.formKey }]).addresses).toEqual([A]);
  });

  it('carries a header\'s origin', () => {
    const header = { formKey: '000000:A.esp', origin: 'ModA' };
    expect(recordOpenPlan(header, undefined).addresses).toEqual([header]);
  });

  it('skips a row that states no record', () => {
    expect(recordOpenPlan({ kind: 'recordType' }, [{ kind: 'recordType' }]).addresses).toEqual([]);
  });

  it('opens nothing for no Argument', () => {
    expect(recordOpenPlan(undefined, undefined).addresses).toEqual([]);
  });
});
