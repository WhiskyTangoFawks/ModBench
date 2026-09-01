import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW } from './messages';

// VMAD's structural-op right-click menu — same
// broadcast-and-self-filter shape as ArrayDiffRows.test.tsx's own unsorted-array-editing
// suite (the extension host has no live reference into this panel's React state), except
// every op here (bar Add Property's own dialog) collapses to one VMAD_STRUCTURAL_OP broadcast
// carrying an op-envelope value RecordFieldWriter.ApplyVmadField already dispatches on
// — writing through the exact same EDIT_FIELD write path every other gesture uses, with no
// webview-side computation of a next value the way an array op needs.

const strMeta: FieldMetadata = { name: 'Name', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };

const vmadEditableCompareResult = {
  conflictAll: 'OnlyOne',
  hasVmad: true,
  overrides: [{
    formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
    loadOrderIndex: 0, isWinner: true, editorId: 'TestNPC',
    fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
  }],
  diffs: [{
    fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
    winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {},
  }],
  vmad: {
    scripts: [{
      name: 'MyScript', flags: { 'MyMod.esp': 'Local' }, winnerColumn: 'MyMod.esp', cellStates: {},
      properties: [
        {
          name: 'Enabled', kind: 'scalar', values: { 'MyMod.esp': false }, types: { 'MyMod.esp': 'Bool' },
          winnerColumn: 'MyMod.esp', cellStates: {}, children: null,
        },
        // #660: a string and a scalar-array property — each carries its own wirePath
        // (`VMAD\MyScript\<name>`, buildScript) two levels below vmadTree.diffs's own top level
        // (wrapper → script → property), the exact shape the flat top-level lookup could never reach.
        {
          name: 'Greeting', kind: 'scalar', values: { 'MyMod.esp': 'hello' }, types: { 'MyMod.esp': 'String' },
          winnerColumn: 'MyMod.esp', cellStates: {}, children: null,
        },
        {
          name: 'Levels', kind: 'array', values: {}, types: { 'MyMod.esp': 'ArrayOfInt' },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [
            { name: '', kind: 'scalar', values: { 'MyMod.esp': 1 }, types: { 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: {} },
            { name: '', kind: 'scalar', values: { 'MyMod.esp': 2 }, types: { 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: {} },
            { name: '', kind: 'scalar', values: { 'MyMod.esp': 3 }, types: { 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: {} },
          ],
        },
        // #658: ArrayOfObject — a separate synthetic shape (VmadCodec.ElementType's own "Object"
        // entry), deliberately out of scope. Element kind 'object' resolves to OBJECT_META
        // (type: 'vmadObject'), the one signal handleArrayOp's VMAD branch uses to keep this
        // property on the pre-#658 client-side carve-out.
        {
          name: 'Refs', kind: 'array', values: {}, types: { 'MyMod.esp': 'ArrayOfObject' },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [
            { name: '', kind: 'object', values: { 'MyMod.esp': '000010:Fallout4.esm [-1]' }, types: { 'MyMod.esp': 'Object' }, winnerColumn: 'MyMod.esp', cellStates: {} },
            { name: '', kind: 'object', values: { 'MyMod.esp': '000011:Fallout4.esm [-1]' }, types: { 'MyMod.esp': 'Object' }, winnerColumn: 'MyMod.esp', cellStates: {} },
          ],
        },
      ],
    }],
  },
};

function fakeVmadClient(): RecordPanelClient {
  return {
    load: vi.fn().mockResolvedValue({
      ok: true, result: vmadEditableCompareResult,
      immutableSet: new Set(), notInLoadOrderSet: new Set(),
      trackedSet: new Set([columnKey('MyMod.esp', 'Data')]),
      conflictsComputed: true,
    }),
    conditionRunOnTargets: vi.fn().mockResolvedValue([]),
  };
}

function renderVmadPanel() {
  const client = fakeVmadClient();
  return { client, ...render(<RecordPanel client={client} />) };
}

function lastEditFieldMessage(): { fieldPath?: string; value?: unknown } | undefined {
  const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
  const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
  return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
}

describe('RecordPanel — VMAD structural-op right-click menu (issue #231)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the "Scripts (VMAD)" wrapper row carries the vmadScripts context on a mutable column', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    const cell = screen.getByText('Scripts (VMAD)').closest('tr')!.querySelectorAll('td')[1];
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'vmadScripts', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      preventDefaultContextMenuItems: true,
    });
  });

  it('a script row carries the vmadScript context (seeded with its current flags) on a mutable column', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    const cell = screen.getByText('MyScript').closest('tr')!.querySelectorAll('td')[1];
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'vmadScript', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      scriptName: 'MyScript', currentFlags: 'Local', preventDefaultContextMenuItems: true,
    });
  });

  it('a property row carries the vmadProperty context on a mutable column', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('Enabled'));
    const cell = screen.getByText('Enabled').closest('tr')!.querySelectorAll('td')[1];
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'vmadProperty', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      scriptName: 'MyScript', propName: 'Enabled', preventDefaultContextMenuItems: true,
    });
  });

  it('VMAD_STRUCTURAL_OP (remove_script) writes the op-envelope via EDIT_FIELD', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript', value: { op: 'remove_script' },
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript', value: { op: 'remove_script' },
    }));
  });

  it('VMAD_STRUCTURAL_OP for a different open record is ignored', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: '999999:Other.esp',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript', value: { op: 'remove_script' },
    }, '*');
    await new Promise(r => setTimeout(r, 0));
    expect((vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .some(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)).toBe(false);
  });

  it('VMAD_OPEN_ADD_PROPERTY opens the Add Property dialog, and confirming commits an add_property op', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript',
    }, '*');

    await waitFor(() => screen.getByText('Add property'));
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'NewProp' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\NewProp',
      value: { op: 'add_property', name: 'NewProp', type: 'Int', value: 0 },
    }));
    expect(screen.queryByText('Add property')).not.toBeInTheDocument();
  });

  it('VMAD_OPEN_ADD_PROPERTY for a different open record is ignored', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY, formKey: '999999:Other.esp',
      plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript',
    }, '*');
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText('Add property')).not.toBeInTheDocument();
  });
});

// #660: a VMAD property's own FieldDiff sits two levels below vmadTree.diffs's own top level
// (wrapper → script → property, buildVmadRows/buildScript) — a name-based lookup across only the
// *flattened top level* of vmadTree.diffs can therefore never find it (nor even a script's own
// diff, since vmadTree.diffs is itself a single-element wrapper array). Both handlers that resolve
// a VMAD op's root FieldDiff by name (handleArrayOp's VMAD branch, handleOpenExtended) now walk the
// tree instead, so both a VMAD string property's extended-editor save and a VMAD scalar-array
// property's arity op find their own root and commit — this is what makes the DOM-level round trip
// below possible at all (previously nothing could be observed to land: see the superseded rationale
// this replaced, computeArrayOpClientSide's own unit tests below).
describe('RecordPanel — a VMAD property resolves its own root through the script tree, not the flattened top level (#660)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  function lastOpenExtendedEditorRequestId(): string {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR);
    return (call?.[0] as { requestId: string }).requestId;
  }

  // The worse half (#660's own framing): the user opens the tab, types, saves, and every signal
  // says it worked — the extended-editor's own save round trip, mirroring RecordPanel.test.tsx's
  // "opens the extended editor bridge call" test for the open half and ArrayDiffRows.test.tsx's
  // "#533" suite for the commit half, but rooted at a VMAD property's own wirePath instead of an
  // ordinary top-level field.
  it("a VMAD string property's extended-editor save commits under the property's own wirePath", async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldName: 'Greeting',
      value: 'hello', readOnly: false, path: [], rootField: 'VMAD\\MyScript\\Greeting',
    }, '*');
    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR,
    })));
    const requestId = lastOpenExtendedEditorRequestId();

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId, value: 'goodbye',
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\Greeting', value: 'goodbye',
    }));
  });

  // #658: a Papyrus scalar-array property's own arity ops relocate here — VmadCodec's own
  // structural-op vocabulary (add_element/remove_element/move_element_up/move_element_down,
  // VmadCodecTests/VmadStructuralOpDispatchTests pin the codec's own arithmetic and dispatch), the
  // same door VMAD_STRUCTURAL_OP's six ops already use, computed server-side. `index` alone (no
  // path) is enough because a Papyrus scalar array cannot nest. ArrayOfObject is a different,
  // synthetic shape (deliberately out of #658's scope) and keeps computing client-side — see
  // "RecordPanel — VMAD ArrayOfObject still computes client-side" below.
  it('ARRAY_STRUCTURAL_OP (remove) on a VMAD scalar-array property posts a remove_element envelope under its own wirePath', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', rootField: 'VMAD\\MyScript\\Levels',
      path: [{ kind: 'index', index: 0 }], op: 'remove',
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\Levels',
      value: { op: 'remove_element', index: 0 },
    }));
  });

  it('ARRAY_STRUCTURAL_OP (add) on a VMAD scalar-array property posts a bare add_element envelope (no index)', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', rootField: 'VMAD\\MyScript\\Levels',
      path: [], op: 'add',
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\Levels',
      value: { op: 'add_element' },
    }));
  });

  it('ARRAY_STRUCTURAL_OP (moveUp) on a VMAD scalar-array property posts a move_element_up envelope', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', rootField: 'VMAD\\MyScript\\Levels',
      path: [{ kind: 'index', index: 1 }], op: 'moveUp',
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\Levels',
      value: { op: 'move_element_up', index: 1 },
    }));
  });

  it('ARRAY_STRUCTURAL_OP (moveDown) on a VMAD scalar-array property posts a move_element_down envelope', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', rootField: 'VMAD\\MyScript\\Levels',
      path: [{ kind: 'index', index: 1 }], op: 'moveDown',
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\Levels',
      value: { op: 'move_element_down', index: 1 },
    }));
  });

  // #658's own trap, named explicitly: ArrayOfObject is a separate synthetic shape, deliberately
  // out of scope, and must keep computing client-side exactly as it did before this ticket —
  // VmadCodec's new add_element/remove_element/move_element_up/move_element_down only match the
  // four scalar-list types (VmadCodecTests), so an envelope posted for an ArrayOfObject property
  // would refuse as NotFound. This is the regression review caught in #630 for Conditions,
  // recurring here for VMAD's own second carve-out.
  it('ARRAY_STRUCTURAL_OP (remove) on a VMAD ArrayOfObject property still commits a computed array, not an envelope', async () => {
    renderVmadPanel();
    await waitFor(() => screen.getByText('Scripts (VMAD)'));

    window.postMessage({
      type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', rootField: 'VMAD\\MyScript\\Refs',
      path: [{ kind: 'index', index: 0 }], op: 'remove',
    }, '*');

    await waitFor(() => expect(lastEditFieldMessage()).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', fieldPath: 'VMAD\\MyScript\\Refs',
      value: ['000011:Fallout4.esm [-1]'],
    }));
  });
});
