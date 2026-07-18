import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FormKeyPicker } from './FormKeyPicker';
import type { FormKeySearchResult, RecordSessionClient } from './RecordSessionClient';

const mockResults: FormKeySearchResult[] = [
  { formKey: '000001:Test.esp', editorId: 'myKeyword' },
  { formKey: '000002:Test.esp', editorId: null },
];

// The picker owns debounce + abort; the client owns the call. Tests inject a fake client and
// assert on its `searchRecords` calls — no `fetch` stub, no URL-string assertions.
function fakeClient(searchRecords: RecordSessionClient['searchRecords']): RecordSessionClient {
  return {
    searchRecords,
    load: vi.fn(),
    save: vi.fn(),
    revert: vi.fn(),
    copyTo: vi.fn(),
    removeOverride: vi.fn(),
    createRecord: vi.fn(),
  };
}

describe('FormKeyPicker', () => {
  it('renders a search input', () => {
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue(mockResults))} validTypes={['kywd']} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue([]))} validTypes={[]} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Search EditorID…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  // The FormKeyPicker debounces input by 200ms; waitFor polls until the results appear.
  it('shows results from the client after the debounce fires', async () => {
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue(mockResults))} validTypes={['kywd']} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'my' } });
    await waitFor(() => expect(screen.getByText('myKeyword [000001:Test.esp]')).toBeInTheDocument(),
      { timeout: 1000 });
  });

  it('shows the raw formKey when editorId is null', async () => {
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue(mockResults))} validTypes={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'my' } });
    await waitFor(() => expect(screen.getByText('000002:Test.esp')).toBeInTheDocument(),
      { timeout: 1000 });
  });

  it('calls onSelect with the formKey when a result row is clicked', async () => {
    const onSelect = vi.fn();
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue(mockResults))} validTypes={['kywd']} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'my' } });
    await waitFor(() => screen.getByText('myKeyword [000001:Test.esp]'), { timeout: 1000 });
    fireEvent.mouseDown(screen.getByText('myKeyword [000001:Test.esp]'));
    expect(onSelect).toHaveBeenCalledWith('000001:Test.esp');
  });

  it('calls onSelect with the first result when Enter is pressed', async () => {
    const onSelect = vi.fn();
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue(mockResults))} validTypes={[]} onSelect={onSelect} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search EditorID…');
    fireEvent.change(input, { target: { value: 'my' } });
    await waitFor(() => screen.getByText('myKeyword [000001:Test.esp]'), { timeout: 1000 });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('000001:Test.esp');
  });

  it('moves selection to the second result when ArrowDown is pressed', async () => {
    const onSelect = vi.fn();
    render(<FormKeyPicker client={fakeClient(vi.fn().mockResolvedValue(mockResults))} validTypes={[]} onSelect={onSelect} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search EditorID…');
    fireEvent.change(input, { target: { value: 'my' } });
    await waitFor(() => screen.getByText('myKeyword [000001:Test.esp]'), { timeout: 1000 });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('000002:Test.esp');
  });

  it('passes the validTypes through to the client search', async () => {
    const searchRecords = vi.fn().mockResolvedValue([]);
    render(<FormKeyPicker client={fakeClient(searchRecords)} validTypes={['kywd']} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'sword' } });
    await waitFor(() => expect(searchRecords).toHaveBeenCalled(), { timeout: 1000 });
    expect(searchRecords).toHaveBeenCalledWith('sword', ['kywd'], expect.any(AbortSignal));
  });

  it('does not restore stale results when input is cleared while a search is in-flight', async () => {
    let resolveSearch!: (r: FormKeySearchResult[]) => void;
    const searchRecords = vi.fn((_q: string, _t: string[], signal?: AbortSignal) =>
      new Promise<FormKeySearchResult[]>((resolve, reject) => {
        resolveSearch = resolve;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    render(<FormKeyPicker client={fakeClient(searchRecords)} validTypes={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search EditorID…');

    fireEvent.change(input, { target: { value: 'my' } });
    await waitFor(() => expect(searchRecords).toHaveBeenCalled(), { timeout: 1000 });

    // Clear input — should abort the in-flight request.
    fireEvent.change(input, { target: { value: '' } });

    // Resolve the stale search response anyway.
    act(() => { resolveSearch(mockResults); });

    // Results must not appear — request was aborted.
    expect(screen.queryByText('myKeyword [000001:Test.esp]')).not.toBeInTheDocument();
  });
});
