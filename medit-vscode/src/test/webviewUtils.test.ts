import { describe, expect, it } from 'vitest';
import { buildColumns } from '../../webview/src/recordUtils';
import type { RecordDetail } from '../../webview/src/types';

function makeOverride(plugin: string, pendingFields?: Record<string, unknown>): RecordDetail {
  return {
    formKey: 'Fallout4.esm:000001',
    plugin,
    loadOrderIndex: 0,
    isWinner: false,
    editorId: null,
    fields: [],
    ...(pendingFields !== undefined ? { pendingFields } : {}),
  };
}

describe('buildColumns', () => {
  it('builds disk-only columns when no pending fields', () => {
    const cols = buildColumns([makeOverride('A'), makeOverride('B')]);
    expect(cols).toHaveLength(2);
    expect(cols[0].kind).toBe('disk');
    expect(cols[1].kind).toBe('disk');
  });

  it('inserts pending column after plugin with pending fields', () => {
    const cols = buildColumns([
      makeOverride('A', { fieldA: 'new' }),
      makeOverride('B'),
    ]);
    expect(cols).toHaveLength(3);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
    expect(cols[1]).toMatchObject({ kind: 'pending', plugin: 'A' });
    expect(cols[2]).toMatchObject({ kind: 'disk' });
  });

  it('inserts pending columns for all plugins with pending fields', () => {
    const cols = buildColumns([
      makeOverride('A', { f: 'x' }),
      makeOverride('B', { f: 'y' }),
    ]);
    expect(cols).toHaveLength(4);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
    expect(cols[1]).toMatchObject({ kind: 'pending', plugin: 'A' });
    expect(cols[2]).toMatchObject({ kind: 'disk' });
    expect(cols[3]).toMatchObject({ kind: 'pending', plugin: 'B' });
  });

  it('does not insert pending column for empty pendingFields object', () => {
    const cols = buildColumns([makeOverride('A', {})]);
    expect(cols).toHaveLength(1);
  });

  it('does not insert pending column for immutable plugin even with pendingFields', () => {
    const immutableSet = new Set(['A']);
    const cols = buildColumns([makeOverride('A', { f: 'x' })], immutableSet);
    expect(cols).toHaveLength(1);
    expect(cols[0].kind).toBe('disk');
  });

  it('inserts pending column for mutable plugin when immutableSet excludes it', () => {
    const immutableSet = new Set(['Fallout4.esm']);
    const cols = buildColumns([makeOverride('A', { f: 'x' })], immutableSet);
    expect(cols).toHaveLength(2);
    expect(cols[1]).toMatchObject({ kind: 'pending', plugin: 'A' });
  });
});
