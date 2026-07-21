import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ScalarCell } from './ScalarCell';
import type { FieldMetadata } from './types';

// ── shared metadata fixtures ──────────────────────────────────────────────────

const strMeta: FieldMetadata  = { name: 'Name',   type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
const intMeta: FieldMetadata  = { name: 'Level',  type: 'int',    isArray: false, validFormKeyTypes: [], enumValues: [] };
const floatMeta: FieldMetadata = { name: 'Weight', type: 'float',  isArray: false, validFormKeyTypes: [], enumValues: [] };
const boolMeta: FieldMetadata = { name: 'Female', type: 'bool',   isArray: false, validFormKeyTypes: [], enumValues: [] };
const enumMeta: FieldMetadata = {
  name: 'Gender', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumValues: ['Male', 'Female', 'None'],
};

describe('ScalarCell — read-only column', () => {
  it('shows the string value', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('shows "—" for null', () => {
    render(<ScalarCell value={null} meta={strMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows numeric value as text', () => {
    render(<ScalarCell value={42} meta={intMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

// Issue #111: an editable cell renders as text until it is clicked — reading conflicts at a
// glance is the grid's primary job, so only the clicked cell becomes an input (xEdit's
// toEditOnClick). Commit or blur returns it to text.
describe('ScalarCell — editable column renders text until clicked', () => {
  it('renders text, not an input, before it is clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('swaps to a text input for string type when clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dogmeat').type).toBe('text');
  });

  it('returns to text on blur', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('renders a number input for int type when clicked', () => {
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('5'));
    expect(screen.getByDisplayValue('5').type).toBe('number');
  });

  it('calls onCommit with a number (not a string) when int input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
    expect(typeof onCommit.mock.calls[0][0]).toBe('number');
  });

  it('calls onCommit with a float when float input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={1.5} meta={floatMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('1.5'));
    const input = screen.getByDisplayValue('1.5');
    fireEvent.change(input, { target: { value: '3.14' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(3.14);
  });

  it('swaps to a checkbox for bool type when clicked', () => {
    render(<ScalarCell value={false} meta={boolMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('false'));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox').checked).toBe(false);
  });

  // Activating a bool must not toggle it: a stray click would otherwise stage a change.
  it('does not commit merely by activating a bool cell', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('false'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('calls onCommit with true when the activated bool checkbox is clicked', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('false'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('swaps to a select with all enum options when clicked', () => {
    render(<ScalarCell value="Male" meta={enumMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Male'));
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Male' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Female' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
  });

  it('calls onCommit with Enter key on a text input', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="old" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('old'));
    const input = screen.getByDisplayValue('old');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
  });
});

// Issue #111: click-to-activate puts every cell one mis-click away from staging. A change whose
// old value equals its new value is not an edit — it is noise in the Pending Changes tree, and
// it drags a whole ChangeGroup's dependency closure along with it (ADR-0028). The bool path
// guarded this from the start; every type needs it, because any cell can now be mis-clicked.
describe('ScalarCell — a no-op edit stages nothing', () => {
  it('does not commit when a text cell is activated and blurred without editing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when a number cell is activated and blurred without editing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    fireEvent.blur(screen.getByDisplayValue('5'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when an enum cell is activated and blurred without changing the selection', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Male" meta={enumMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Male'));
    fireEvent.blur(screen.getByRole('combobox'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when a text edit is typed and then reverted by hand before blur', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    const input = screen.getByDisplayValue('Dogmeat');
    fireEvent.change(input, { target: { value: 'Dogmeat!' } });
    fireEvent.change(input, { target: { value: 'Dogmeat' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit on Enter when the value is unchanged', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.keyDown(screen.getByDisplayValue('Dogmeat'), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The guard must not swallow a real edit that happens to round-trip through the same string.
  it('still commits a genuine change', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
  });
});
