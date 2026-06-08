import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FormKeyPicker } from './FormKeyPicker';

const mockResults = [
  { formKey: '000001:Test.esp', editorId: 'myKeyword' },
  { formKey: '000002:Test.esp', editorId: null },
];

describe('FormKeyPicker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: mockResults }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a search input', () => {
    render(<FormKeyPicker port={5172} validTypes={['kywd']} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<FormKeyPicker port={5172} validTypes={[]} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Search EditorID…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  // The FormKeyPicker debounces input by 200ms; waitFor polls until the results appear.
  it('shows results from the backend after the debounce fires', async () => {
    render(<FormKeyPicker port={5172} validTypes={['kywd']} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'my' } });
    await waitFor(() => expect(screen.getByText('myKeyword [000001:Test.esp]')).toBeInTheDocument(),
      { timeout: 1000 });
  });

  it('shows the raw formKey when editorId is null', async () => {
    render(<FormKeyPicker port={5172} validTypes={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'my' } });
    await waitFor(() => expect(screen.getByText('000002:Test.esp')).toBeInTheDocument(),
      { timeout: 1000 });
  });

  it('calls onSelect with the formKey when a result row is clicked', async () => {
    const onSelect = vi.fn();
    render(<FormKeyPicker port={5172} validTypes={['kywd']} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'my' } });
    await waitFor(() => screen.getByText('myKeyword [000001:Test.esp]'), { timeout: 1000 });
    fireEvent.mouseDown(screen.getByText('myKeyword [000001:Test.esp]'));
    expect(onSelect).toHaveBeenCalledWith('000001:Test.esp');
  });

  it('calls onSelect with the first result when Enter is pressed', async () => {
    const onSelect = vi.fn();
    render(<FormKeyPicker port={5172} validTypes={[]} onSelect={onSelect} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search EditorID…');
    fireEvent.change(input, { target: { value: 'my' } });
    await waitFor(() => screen.getByText('myKeyword [000001:Test.esp]'), { timeout: 1000 });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('000001:Test.esp');
  });

  it('moves selection to the second result when ArrowDown is pressed', async () => {
    const onSelect = vi.fn();
    render(<FormKeyPicker port={5172} validTypes={[]} onSelect={onSelect} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search EditorID…');
    fireEvent.change(input, { target: { value: 'my' } });
    await waitFor(() => screen.getByText('myKeyword [000001:Test.esp]'), { timeout: 1000 });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('000002:Test.esp');
  });

  it('includes the type param in the fetch URL for single validTypes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ items: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<FormKeyPicker port={5172} validTypes={['kywd']} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search EditorID…'), { target: { value: 'sword' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 1000 });
    expect(fetchMock.mock.calls[0][0]).toContain('type=kywd');
  });

  it('does not restore stale results when input is cleared while fetch is in-flight', async () => {
    let resolveFetch!: () => void;
    const fetchMock = vi.fn(() => new Promise<{ ok: boolean; json: () => Promise<{ items: typeof mockResults }> }>(resolve => {
      resolveFetch = () => resolve({ ok: true, json: () => Promise.resolve({ items: mockResults }) });
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FormKeyPicker port={5172} validTypes={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search EditorID…');

    fireEvent.change(input, { target: { value: 'my' } });
    // Wait for debounce to fire and fetch to be called
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 1000 });

    // Clear input — should abort the in-flight request
    fireEvent.change(input, { target: { value: '' } });

    // Resolve the stale fetch response
    act(() => { resolveFetch(); });

    // Results must not appear — request was aborted
    expect(screen.queryByText('myKeyword [000001:Test.esp]')).not.toBeInTheDocument();
  });
});
