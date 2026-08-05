import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({ pickFormKey: (...args: unknown[]) => pickFormKey(...args) }));

import { VmadObjectCell } from './VmadObjectCell';

// Issue #231: the `renderCell` dispatch target for `meta.type === 'vmadObject'` — a thin adapter
// from the unified tree's plain (value, onCommit, onOpen) leaf contract onto #229's
// VmadObjectEditor, building the same compact "FormKeyLink + [alias]" read view VmadSection's own
// leafContent used to render.
describe('VmadObjectCell', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('renders a FormKeyLink for the FormKey part and the trailing [alias]', () => {
    render(<VmadObjectCell value="000123:Foo.esp [2]" onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
    expect(screen.getByText('[2]')).toBeInTheDocument();
  });

  it('shows a dash for an empty value', () => {
    render(<VmadObjectCell value="" onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('a plain click activates the editor (composes the shared FormKeyCell plus an alias input)', () => {
    render(<VmadObjectCell value="000123:Foo.esp [2]" onCommit={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    expect(screen.getByLabelText('Alias')).toHaveValue(2);
  });

  it('Ctrl+click follows the reference instead of activating the editor', () => {
    const onOpen = vi.fn();
    render(<VmadObjectCell
      value="000123:Foo.esp [2]" onCommit={vi.fn()} onOpen={onOpen}
      resolution={{ state: 'ResolvedValidType', recordType: 'npc_', editorId: 'Foo' }}
    />);
    fireEvent.click(screen.getByText('Foo [000123:Foo.esp]'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000123:Foo.esp');
    expect(screen.queryByLabelText('Alias')).not.toBeInTheDocument();
  });
});
