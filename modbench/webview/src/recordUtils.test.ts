import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  parseElementIndex,
  pendingIfChanged,
  extractPendingElementValue,
  updateArrayAtKey,
} from './recordUtils';
import type { RecordDetail } from './types';

function makeOverride(plugin: string, extra: Partial<RecordDetail> = {}): RecordDetail {
  return {
    formKey: '000001:Test.esp',
    plugin,
    loadOrderIndex: 0,
    isWinner: false,
    editorId: null,
    fields: [],
    ...extra,
  };
}

describe('buildColumns', () => {
  it('produces one disk column per override when there are no pending changes', () => {
    const cols = buildColumns([makeOverride('Fallout4.esm'), makeOverride('MyMod.esp')]);
    expect(cols).toHaveLength(2);
    expect(cols.every(c => c.kind === 'disk')).toBe(true);
  });

  it('adds a pending column after a mutable override that has pending fields', () => {
    const cols = buildColumns([makeOverride('MyMod.esp', { pendingFields: { Name: 'draft' } })]);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
    expect(cols[1]).toMatchObject({ kind: 'pending', plugin: 'MyMod.esp' });
  });

  it('skips the pending column for immutable overrides even if they have pending fields', () => {
    const cols = buildColumns(
      [makeOverride('Fallout4.esm', { pendingFields: { Name: 'draft' } })],
      new Set(['Fallout4.esm']),
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
  });

  it('skips the pending column when pendingFields is present but empty', () => {
    const cols = buildColumns([makeOverride('MyMod.esp', { pendingFields: {} })]);
    expect(cols).toHaveLength(1);
  });

  it('places the pending column immediately after its parent disk column', () => {
    const overrides = [
      makeOverride('Fallout4.esm'),
      makeOverride('MyMod.esp', { pendingFields: { Name: 'draft' } }),
      makeOverride('Other.esp'),
    ];
    const cols = buildColumns(overrides);
    expect(cols).toHaveLength(4);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
    expect(cols[1]).toMatchObject({ kind: 'disk' });                       // MyMod.esp disk
    expect(cols[2]).toMatchObject({ kind: 'pending', plugin: 'MyMod.esp' }); // MyMod.esp pending
    expect(cols[3]).toMatchObject({ kind: 'disk' });                       // Other.esp disk
  });
});

describe('parseElementIndex', () => {
  it('parses the numeric index out of an "[N]" field name', () => {
    expect(parseElementIndex('[0]')).toBe(0);
    expect(parseElementIndex('[12]')).toBe(12);
  });
});

describe('pendingIfChanged', () => {
  it('returns undefined when pending is undefined', () => {
    expect(pendingIfChanged(undefined, 'disk')).toBeUndefined();
  });

  it('returns undefined when pending === disk (reference/primitive equal)', () => {
    expect(pendingIfChanged('same', 'same')).toBeUndefined();
  });

  it('returns undefined when pending deep-equals disk (structural)', () => {
    expect(pendingIfChanged({ X1: 0 }, { X1: 0 })).toBeUndefined();
  });

  it('returns pending when it differs from disk', () => {
    expect(pendingIfChanged({ X1: 5 }, { X1: 0 })).toEqual({ X1: 5 });
  });
});

describe('extractPendingElementValue', () => {
  it('returns undefined when rawPending is not an array', () => {
    expect(extractPendingElementValue(undefined, '[0]', false, 'alpha')).toBeUndefined();
  });

  it('sortable array: returns the field name itself when present in rawPending and it changed', () => {
    // sortable arrays key elements by value, not index — presence, not position, is the pending signal.
    expect(extractPendingElementValue(['KwdA', 'KwdC'], 'KwdC', true, undefined)).toBe('KwdC');
  });

  it('sortable array: returns undefined when the element is absent from rawPending', () => {
    expect(extractPendingElementValue(['KwdA'], 'KwdC', true, undefined)).toBeUndefined();
  });

  it('unsorted array: returns the element at the parsed index when it changed from disk', () => {
    expect(extractPendingElementValue(['alpha', 'delta'], '[1]', false, 'gamma')).toBe('delta');
  });

  it('unsorted array: returns undefined when the index is out of range', () => {
    expect(extractPendingElementValue(['alpha'], '[3]', false, undefined)).toBeUndefined();
  });

  it('unsorted array: returns undefined when the element at the index equals disk', () => {
    expect(extractPendingElementValue(['alpha', 'beta'], '[1]', false, 'beta')).toBeUndefined();
  });
});

describe('updateArrayAtKey', () => {
  it('sortable array: replaces the element matching elementKey by value', () => {
    expect(updateArrayAtKey(['KwdA', 'KwdB'], 'KwdB', 'KwdC', true)).toEqual(['KwdA', 'KwdC']);
  });

  it('unsorted array: replaces the element at the parsed index', () => {
    expect(updateArrayAtKey(['alpha', 'beta'], '[1]', 'gamma', false)).toEqual(['alpha', 'gamma']);
  });

  it('leaves other elements untouched', () => {
    expect(updateArrayAtKey(['a', 'b', 'c'], '[0]', 'z', false)).toEqual(['z', 'b', 'c']);
  });
});
