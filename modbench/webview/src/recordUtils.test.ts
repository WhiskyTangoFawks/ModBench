import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  parseElementIndex,
  pendingIfChanged,
  extractPendingElementValue,
  updateArrayAtKey,
  moveArrayElement,
  removeArrayElement,
  appendArrayElement,
  arrayElementContext,
  arrayParentContext,
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

// Issue #227: the pure mutations behind Move Up/Move Down/Remove/Add — extracted out of #142's
// DiffRow-local ArrayElementControls/ArrayAddButton so both the keyboard accelerator (DiskCell,
// in-webview only) and the right-click menu's broadcast handler (RecordPanel, arriving via the
// extension host) restage identically without sharing a runtime call path.
describe('moveArrayElement', () => {
  it('swaps the element at index with its neighbour one position up', () => {
    expect(moveArrayElement(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
  });

  it('swaps the element at index with its neighbour one position down', () => {
    expect(moveArrayElement(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('returns the array unchanged when the move would go out of bounds', () => {
    expect(moveArrayElement(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveArrayElement(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('removeArrayElement', () => {
  it('drops the element at the given index, leaving the others in order', () => {
    expect(removeArrayElement(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });
});

describe('appendArrayElement', () => {
  it('appends the given value to the end of the array', () => {
    expect(appendArrayElement(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the source array', () => {
    const source = ['a', 'b'];
    appendArrayElement(source, 'c');
    expect(source).toEqual(['a', 'b']);
  });
});

describe('arrayElementContext', () => {
  it('produces the data-vscode-context JSON for a middle element (can move either way)', () => {
    expect(JSON.parse(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'Items', 1, 3))).toEqual({
      webviewSection: 'arrayElement',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      fieldName: 'Items',
      index: 1,
      canMoveUp: true,
      canMoveDown: true,
      preventDefaultContextMenuItems: true,
    });
  });

  // Issue #227 review: package.json's `when` clause gates Move Up/Move Down on these two flags
  // the same way it gates columnHeader.removeOverride on `!immutable` — a boundary element has
  // nothing to move onto, so the menu item must be absent there, not merely a no-op when clicked
  // (matching the AC's "absent, not disabled" principle for sorted arrays).
  it('canMoveUp is false for the first element', () => {
    expect(JSON.parse(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'Items', 0, 3)).canMoveUp).toBe(false);
  });

  it('canMoveDown is false for the last element', () => {
    expect(JSON.parse(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'Items', 2, 3)).canMoveDown).toBe(false);
  });
});

describe('arrayParentContext', () => {
  it('produces the data-vscode-context JSON for an array-parent cell', () => {
    expect(JSON.parse(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'Items'))).toEqual({
      webviewSection: 'arrayParent',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      fieldName: 'Items',
      preventDefaultContextMenuItems: true,
    });
  });
});
