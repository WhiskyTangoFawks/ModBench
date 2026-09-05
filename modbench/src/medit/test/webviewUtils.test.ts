import { describe, expect, it } from 'vitest';
import { buildColumns } from '../../../webview/src/recordUtils';
import type { RecordDetail } from '../../../webview/src/types';

function makeOverride(plugin: string, loadOrderIndex = 0): RecordDetail {
  return {
    formKey: 'Fallout4.esm:000001',
    plugin,
    loadOrderIndex,
    isWinner: false,
    editorId: null,
    fields: [],
  };
}

describe('buildColumns', () => {
  it('builds one column per override', () => {
    const cols = buildColumns([makeOverride('A', 0), { ...makeOverride('B', 5), isWinner: true }]);
    expect(cols).toHaveLength(2);
    expect(cols.map(c => c.override.plugin)).toEqual(['A', 'B']);
  });

});
