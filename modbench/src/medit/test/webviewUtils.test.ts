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
  // #618 follow-up: one column per override, in the wire's own load order. Mirrors
  // recordUtils.test.ts's own thorough coverage of this seam; this file only pins the extension
  // host's own import path into it stays wired.
  it('builds one disk column per override', () => {
    const cols = buildColumns([makeOverride('A', 0), { ...makeOverride('B', 5), isWinner: true }]);
    expect(cols).toHaveLength(2);
    expect(cols.map(c => c.kind)).toEqual(['disk', 'disk']);
    expect(cols.map(c => c.override.plugin)).toEqual(['A', 'B']);
  });

});
