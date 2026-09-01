import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { columnKey } from './types';
import type { RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';
import type { ParsedCondition, ConditionDiff } from './types';

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
