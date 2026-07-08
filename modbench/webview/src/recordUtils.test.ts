import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import { buildColumns } from './recordUtils';
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
