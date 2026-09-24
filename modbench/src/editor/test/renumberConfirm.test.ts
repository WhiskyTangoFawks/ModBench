import { describe, it, expect } from 'vitest';
import { danglingReferencers, renumberConfirmMessage } from '../renumberConfirm';
import { referenceResultFixture } from '../../client/test/fixtures';

describe('danglingReferencers', () => {
  const A = { formKey: '000800:A.esp', plugin: 'A.esp', origin: 'ModA' };
  const B = { formKey: '000801:A.esp', plugin: 'A.esp', origin: 'ModA' };

  it('counts a record once however many of its fields hold the reference', () => {
    expect(danglingReferencers([[A, [
      referenceResultFixture({ formKey: '000001:B.esp', plugin: 'B.esp', origin: 'ModB', fieldPath: 'F' }),
      referenceResultFixture({ formKey: '000001:B.esp', plugin: 'B.esp', origin: 'ModB', fieldPath: 'G' }),
      referenceResultFixture({ formKey: '000002:C.esp', plugin: 'C.esp', origin: 'ModC' }),
    ]]])).toBe(2);
  });

  it('counts each copy of a plugin as its own referencing record', () => {
    expect(danglingReferencers([[A, [
      referenceResultFixture({ formKey: '000001:B.esp', plugin: 'B.esp', origin: 'ModB' }),
      referenceResultFixture({ formKey: '000001:B.esp', plugin: 'B.esp', origin: 'OtherModB' }),
    ]]])).toBe(2);
  });

  it('counts a record referencing several of the selection once', () => {
    const referencer = referenceResultFixture({ formKey: '000001:B.esp', plugin: 'B.esp', origin: 'ModB' });
    expect(danglingReferencers([[A, [referencer]], [B, [referencer]]])).toBe(1);
  });

  it('leaves out a record\'s reference to itself', () => {
    expect(danglingReferencers([[A, [referenceResultFixture({ ...A })]]])).toBe(0);
  });

  it('counts a selected record that references another selected record', () => {
    expect(danglingReferencers([[A, []], [B, [referenceResultFixture({ ...A })]]])).toBe(1);
  });
});

describe('renumberConfirmMessage', () => {
  it('asks nothing when no record references the ones renumbered', () => {
    expect(renumberConfirmMessage(['NpcA [000800:A.esp] in A.esp (ModA)'], 0)).toBeNull();
    expect(renumberConfirmMessage(['000800:A.esp in A.esp', '000801:A.esp in A.esp'], 0)).toBeNull();
  });

  it('says how many records will point at nothing until they are updated', () => {
    expect(renumberConfirmMessage(['NpcA [000800:A.esp] in A.esp (ModA)'], 2)).toBe(
      'Renumber NpcA [000800:A.esp] in A.esp (ModA)? '
      + '2 records that reference it will point at nothing until they are updated.');
  });

  it('speaks of one record in the singular', () => {
    expect(renumberConfirmMessage(['000800:A.esp in A.esp'], 1)).toBe(
      'Renumber 000800:A.esp in A.esp? 1 record that references it will point at nothing until it is updated.');
  });

  it('totals the references across a selection', () => {
    expect(renumberConfirmMessage(['000800:A.esp in A.esp', '000801:A.esp in A.esp', '000802:A.esp in A.esp'], 5)).toBe(
      'Renumber 3 records? 5 records that reference them will point at nothing until they are updated.');
  });

  it('still asks, saying so, when the references could not be counted', () => {
    expect(renumberConfirmMessage(['000800:A.esp in A.esp'], undefined)).toBe(
      'Renumber 000800:A.esp in A.esp? Its references could not be counted: '
      + 'any record that references it will point at nothing until it is updated.');
    expect(renumberConfirmMessage(['000800:A.esp in A.esp', '000801:A.esp in A.esp'], undefined)).toBe(
      'Renumber 2 records? Their references could not be counted: '
      + 'any record that references them will point at nothing until it is updated.');
  });
});
