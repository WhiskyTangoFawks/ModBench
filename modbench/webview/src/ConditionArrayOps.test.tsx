import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel, computeArrayOpClientSide } from './RecordPanel';
import { columnKey } from './types';
import type { RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';
import type { FieldMetadata, ParsedCondition, ConditionDiff } from './types';

// #630 review: a Condition-owning field carries the same generic `{type: 'array'}` wire shape an
// ordinary array does, so it reaches the identical right-click/keyboard array-op UI — but its
// backend dispatch (Fallout4ConditionCodec.ApplyListValue) requires a JSON array and refuses an
// op-envelope object outright (RecordFieldWriter routes a Condition-list fieldPath there before
// ArrayOpWriter's own envelope detection ever runs). Posting an envelope under a Condition path is
// therefore a guaranteed refusal, not merely unsupported — confirmed in review by two independent
// routes to the same guard, and empirically here: right-click Remove/Add/Move-Up/Move-Down and
// Insert/Delete/Ctrl+↑/↓ on a Condition row must still compute the next array client-side and
// commit it whole (RecordPanel's own handleArrayOp Condition carve-out, computeArrayOpClientSide),
// exactly as every arity op did before #630 — the VMAD carve-out's own sibling, but with no
// pre-existing lookup gap (a Condition group's own FieldDiff is always a top-level entry in
// conditionTree.diffs, conditionTreeAdapter.ts's own buildConditionRows), so this is pinned
// end-to-end rather than at the computation function alone.

function condition(partial: Partial<ParsedCondition> = {}): ParsedCondition {
  return {
    function: 'GetIsID', operator: 'EqualTo', or: false,
    runOnTarget: 'Subject', runOnReference: null, useGlobal: false,
    comparisonFloat: 0, comparisonGlobal: null, parameters: [],
    ...partial,
  };
}

function conditionDiff(partial: Partial<ConditionDiff> = {}): ConditionDiff {
  return {
    index: 0,
    perPlugin: { 'MyMod.esp': condition() },
    winnerColumn: 'MyMod.esp',
    cellStates: {},
    fieldCellStates: {},
    ...partial,
  };
}

const conditionCompareResult = {
  conflictAll: 'NoConflict',
  overrides: [{
    formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
    loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
    fields: [], conflictThis: 'Master',
  }],
  diffs: [],
  conditions: {
    groups: [{
      fieldPath: 'Conditions',
      conditions: [
        conditionDiff({ index: 0 }),
        conditionDiff({ index: 1, perPlugin: { 'MyMod.esp': condition({ function: 'GetIsSex' }) } }),
      ],
    }],
  },
};

function renderConditionPanel() {
  const client: RecordPanelClient = {
    load: vi.fn().mockResolvedValue({
      ok: true, result: conditionCompareResult,
      immutableSet: new Set(), notInLoadOrderSet: new Set(),
      trackedSet: new Set([columnKey('MyMod.esp', 'Data')]),
      conflictsComputed: true,
    }),
    conditionRunOnTargets: vi.fn().mockResolvedValue([]),
  };
  return { client, ...render(<RecordPanel client={client} />) };
}

function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
  const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
  const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
  return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
}

describe('RecordPanel — a Condition-owning field\'s own arity ops still compute client-side (#630 carve-out)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Delete on a Condition element row commits the whole computed array under the group\'s own field path', async () => {
    renderConditionPanel();
    await waitFor(() => screen.getByText('Conditions'));
    fireEvent.click(screen.getByText('Conditions').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('[1]'));

    const row = screen.getByText('[1]').closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1];
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    await waitFor(() => expect(lastEditField()?.fieldPath).toBe('Conditions'));
    // A computed array (the surviving client-side carve-out), not an op envelope — the tell that
    // this op still takes the pre-#630 shape, the one Fallout4ConditionCodec.ApplyListValue
    // actually accepts.
    const value = lastEditField()?.value;
    expect(Array.isArray(value)).toBe(true);
    expect((value as unknown[]).length).toBe(1);
  });
});

// #658 review: this suite used to be titled "the VMAD scalar-array carve-out (#630)" and live in
// VmadStructuralOps.test.tsx — #658 moved VMAD's own scalar-array arity ops server-side (VmadCodec's
// own add_element/remove_element/move_element_up/move_element_down), so that title stopped
// describing reality. The function itself did not delete: it still backs *two* surviving
// client-side carve-outs neither of which #658 touches — this file's own Condition carve-out above
// (Fallout4ConditionCodec.ApplyListValue requires a JSON array and refuses an op-envelope object)
// and VMAD's own ArrayOfObject carve-out (a separate synthetic shape, deliberately out of #658's
// scope — see RecordPanel.tsx's handleArrayOp). Relocated here, renamed to name both, rather than
// deleted: the arithmetic (boundary no-ops included) is still exactly what both carve-outs depend
// on, pinned independent of whichever tree-walk resolves a given caller's own root.
describe('computeArrayOpClientSide — backs the surviving Condition and VMAD ArrayOfObject carve-outs (#630/#658)', () => {
  // rootValue is one column's own current value (rootDiff.values[plugin] — a plain array), not a
  // per-plugin map. Every caller (Condition group, VMAD ArrayOfObject property) hands this function
  // the same shape regardless of element type, which is exactly why one generic suite covers both.
  const rootValue = [1, 2, 3];

  it('remove: removes the named index and keeps the rest', () => {
    const next = computeArrayOpClientSide(rootValue, [{ kind: 'index', index: 1 }], 'remove');
    expect(next).toEqual([1, 3]);
  });

  it('remove: an out-of-range index is a boundary no-op (undefined — nothing to commit)', () => {
    const next = computeArrayOpClientSide(rootValue, [{ kind: 'index', index: 5 }], 'remove');
    expect(next).toBeUndefined();
  });

  it('moveDown: swaps the named index with its next neighbour', () => {
    const next = computeArrayOpClientSide(rootValue, [{ kind: 'index', index: 0 }], 'moveDown');
    expect(next).toEqual([2, 1, 3]);
  });

  it('moveUp: the first element is a boundary no-op', () => {
    const next = computeArrayOpClientSide(rootValue, [{ kind: 'index', index: 0 }], 'moveUp');
    expect(next).toBeUndefined();
  });

  it('add: appends a default element built from the given element meta', () => {
    const intMeta: FieldMetadata = { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] };
    const next = computeArrayOpClientSide(rootValue, [], 'add', intMeta);
    expect(next).toEqual([1, 2, 3, 0]);
  });

  // The VMAD ArrayOfObject-specific case: `defaultElementValue`'s own 'vmadObject' arm.
  it("add: builds a VMAD ArrayOfObject property's own default element ({formKey: '', alias: -1})", () => {
    const vmadObjectMeta: FieldMetadata = { name: '', type: 'vmadObject', isArray: false, validFormKeyTypes: [], enumValues: [] };
    const next = computeArrayOpClientSide([], [], 'add', vmadObjectMeta);
    expect(next).toEqual([{ formKey: '', alias: -1 }]);
  });
});
