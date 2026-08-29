import { describe, expect, it } from 'vitest';
import { buildColumns } from '../../../webview/src/recordUtils';
import type { RecordDetail } from '../../../webview/src/types';

function makeOverride(plugin: string): RecordDetail {
  return {
    formKey: 'Fallout4.esm:000001',
    plugin,
    loadOrderIndex: 0,
    isWinner: false,
    editorId: null,
    fields: [],
  };
}

describe('buildColumns', () => {
  // #410/ADR-0041: one column per override — the retired companion column is gone.
  it('builds one disk column per override', () => {
    const cols = buildColumns([makeOverride('A'), makeOverride('B')]);
    expect(cols).toHaveLength(2);
    expect(cols[0].kind).toBe('disk');
    expect(cols[1].kind).toBe('disk');
  });

});
