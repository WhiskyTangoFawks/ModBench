import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { RecordSessionClient } from './RecordSessionClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW } from './messages';

// Issue #231 (#426 Track 5: restored): VMAD's structural-op right-click menu — same
// broadcast-and-self-filter shape as ArrayDiffRows.test.tsx's own "array editing (unsorted,
// #426)" suite (the extension host has no live reference into this panel's React state), except
// every op here (bar Add Property's own dialog) collapses to one VMAD_STRUCTURAL_OP broadcast
// carrying an op-envelope value RecordFieldWriter.ApplyVmadField (Track 0) already dispatches on
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
      properties: [{
        name: 'Enabled', kind: 'scalar', values: { 'MyMod.esp': false }, types: { 'MyMod.esp': 'Bool' },
        winnerColumn: 'MyMod.esp', cellStates: {}, children: null,
      }],
    }],
  },
};

function fakeVmadClient(): RecordSessionClient {
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
