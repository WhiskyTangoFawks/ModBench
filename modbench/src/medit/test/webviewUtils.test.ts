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
  // #618: exactly one column — the winning override — never one per override. Mirrors
  // recordUtils.test.ts's own thorough coverage of this seam; this file only pins the extension
  // host's own import path into it stays wired.
  it('builds a single disk column for the winning override', () => {
    const cols = buildColumns([makeOverride('A'), { ...makeOverride('B'), isWinner: true }]);
    expect(cols).toHaveLength(1);
    expect(cols[0].kind).toBe('disk');
    expect(cols[0].override.plugin).toBe('B');
  });

});
