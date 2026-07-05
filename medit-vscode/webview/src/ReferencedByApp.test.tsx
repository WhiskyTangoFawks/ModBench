import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { ReferencedByApp } from './ReferencedByApp';
import { vscode } from './vscode';

const FORM_KEY = '000001:Fallout4.esm';
const PORT = 15172;

function makeFetch(results: unknown) {
  return vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(results) }));
}

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', FORM_KEY);
  vi.stubGlobal('mEditBackendPort', PORT);
  vi.mocked(vscode.postMessage).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReferencedByApp — loading state', () => {
  it('shows "Loading…" while fetch is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<ReferencedByApp />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});

describe('ReferencedByApp — empty state', () => {
  it('shows "No references found" when result is empty', async () => {
    vi.stubGlobal('fetch', makeFetch([]));
    render(<ReferencedByApp />);
    await waitFor(() => expect(screen.getByText('No references found')).toBeInTheDocument());
  });
});

describe('ReferencedByApp — single-plugin group', () => {
  it('shows recordType/editorId header with no count suffix, children hidden by default', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
    ]));
    render(<ReferencedByApp />);
    await waitFor(() => expect(screen.getByText(/NPC_ \/ TestNPC/)).toBeInTheDocument());
    expect(screen.queryByText('(1 plugins)')).not.toBeInTheDocument();
    expect(screen.queryByText('Fallout4.esm')).not.toBeInTheDocument();
  });
});

describe('ReferencedByApp — multi-plugin group', () => {
  it('shows (2 plugins) count; expanding reveals two child rows', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
      { formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
    ]));
    render(<ReferencedByApp />);
    await waitFor(() => expect(screen.getByText(/\(2 plugins\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('expand-toggle'));
    expect(screen.getByText('Fallout4.esm')).toBeInTheDocument();
    expect(screen.getByText('MyMod.esp')).toBeInTheDocument();
  });
});

describe('ReferencedByApp — two distinct groups', () => {
  it('renders two separate group headers', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
      { formKey: '000003:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'Template', recordType: 'NPC_', editorId: 'OtherNPC' },
    ]));
    render(<ReferencedByApp />);
    await waitFor(() => expect(screen.getByText(/NPC_ \/ TestNPC/)).toBeInTheDocument());
    expect(screen.getByText(/NPC_ \/ OtherNPC/)).toBeInTheDocument();
  });
});

describe('ReferencedByApp — navigation', () => {
  it('left-click header sends OPEN_RECORD', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
    ]));
    render(<ReferencedByApp />);
    await waitFor(() => screen.getByText(/NPC_ \/ TestNPC/));
    fireEvent.click(screen.getByText(/NPC_ \/ TestNPC/));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openRecord', formKey: '000002:Fallout4.esm' });
  });

  it('right-click header sends OPEN_RECORD_BESIDE', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
    ]));
    render(<ReferencedByApp />);
    await waitFor(() => screen.getByText(/NPC_ \/ TestNPC/));
    fireEvent.contextMenu(screen.getByText(/NPC_ \/ TestNPC/));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openRecordBeside', formKey: '000002:Fallout4.esm' });
  });
});

describe('ReferencedByApp — child rows', () => {
  it('child rows have no onClick handler', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
      { formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: 'TestNPC' },
    ]));
    render(<ReferencedByApp />);
    await waitFor(() => screen.getByText(/NPC_ \/ TestNPC/));
    fireEvent.click(screen.getByTestId('expand-toggle'));
    vi.mocked(vscode.postMessage).mockClear();
    const childRow = screen.getByText('Fallout4.esm').closest('[data-testid="ref-child-row"]');
    expect(childRow).not.toBeNull();
    fireEvent.click(childRow);
    expect(vscode.postMessage).not.toHaveBeenCalled();
  });
});
