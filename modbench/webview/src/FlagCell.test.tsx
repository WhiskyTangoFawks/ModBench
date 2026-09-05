import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { FlagCell } from './FlagCell';
import type { FieldMetadata } from './types';

// The codec spells a flags member as the array of the names that are set; the metadata lists the
// members, in its own order.
const flagMeta: FieldMetadata = {
  name: 'Flags',
  type: 'flags',
  isArray: false,
  validFormKeyTypes: [],
  enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' },
    { value: 'C', bitValue: '4' }, { value: 'D', bitValue: '8' }],
};

// A deliberate ADR-0034 divergence, recorded there: the checkbox list is the cell — always
// visible, one checkbox per flag, no gesture to reveal it.
describe('FlagCell — always-visible checkbox list', () => {
  it('renders one checkbox per member, checked where the document names it', () => {
    render(<FlagCell value={['A', 'C']} meta={flagMeta} editable onCommit={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toBeChecked();      // A
    expect(boxes[1]).not.toBeChecked();  // B
    expect(boxes[2]).toBeChecked();      // C
    expect(boxes[3]).not.toBeChecked();  // D
  });

  it('labels every checkbox with its member name', () => {
    render(<FlagCell value={[]} meta={flagMeta} editable onCommit={vi.fn()} />);
    for (const m of flagMeta.enumMembers) expect(screen.getByText(m.value)).toBeInTheDocument();
  });

  // Absent means default: no names set, so the list renders all unchecked, never a placeholder.
  it('an absent value renders the full list all-unchecked', () => {
    render(<FlagCell value={null} meta={flagMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

describe('FlagCell — collapsed row', () => {
  it('renders the names set, comma-separated, instead of checkboxes', () => {
    render(<FlagCell value={['A', 'C']} meta={flagMeta} editable onCommit={vi.fn()} collapsed />);
    expect(screen.getByText('A, C')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders nothing when no flags are set', () => {
    const { container } = render(<FlagCell value={[]} meta={flagMeta} editable onCommit={vi.fn()} collapsed />);
    expect(container.textContent).toBe('');
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

describe('FlagCell — read-only column', () => {
  it('renders the same checkbox list, disabled', () => {
    render(<FlagCell value={['A', 'C']} meta={flagMeta} editable={false} onCommit={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    for (const box of boxes) expect(box).toBeDisabled();
    expect(boxes[0]).toBeChecked();
  });

  it('clicking a disabled checkbox never commits', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={['A', 'C']} meta={flagMeta} editable={false} onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// The commit is the document's own spelling: the names now set, as an array.
describe('FlagCell — editing', () => {
  it('unchecking a name commits the array without it', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={['A', 'C']} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onCommit).toHaveBeenCalledWith(['C']);
  });

  it('checking a name commits the array with it appended', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={['A', 'C']} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).toHaveBeenCalledWith(['A', 'C', 'B']);
  });

  it('sets the first flag from an absent value', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={null} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onCommit).toHaveBeenCalledWith(['A']);
  });

  // A name the metadata does not list (a composite the enum declares) is the document's; a
  // toggle of another name leaves it exactly where it was.
  it('keeps a name the metadata does not list when another is toggled', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={['AB', 'C']} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[3]);
    expect(onCommit).toHaveBeenCalledWith(['AB', 'C', 'D']);
  });
});
