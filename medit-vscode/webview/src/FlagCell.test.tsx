import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { FlagCell } from './FlagCell';
import type { FieldMetadata } from './types';

const flagMeta: FieldMetadata = {
  name: 'Flags',
  type: 'enum',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: ['A', 'B', 'C', 'D'],
  enumBitValues: [1, 2, 4, 8],
  isBitmask: true,
};

const sparseFlags: FieldMetadata = {
  name: 'SparseFlags',
  type: 'enum',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: ['X', 'Z'],
  enumBitValues: [1, 4],   // non-sequential: Z is bit 4, not bit 1
  isBitmask: true,
};

describe('FlagCell — read mode', () => {
  it('renders comma-separated names of active flags', () => {
    render(<FlagCell value={0b0101} meta={flagMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('A, C')).toBeInTheDocument();
  });

  it('renders "—" for null value', () => {
    render(<FlagCell value={null} meta={flagMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('FlagCell — edit mode', () => {
  it('renders one checkbox per flag with correct checked state', () => {
    render(<FlagCell value={0b0101} meta={flagMeta} editMode={true} onCommit={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes[0].checked).toBe(true);  // A: bit 0 set
    expect(checkboxes[1].checked).toBe(false); // B: bit 1 not set
    expect(checkboxes[2].checked).toBe(true);  // C: bit 2 set
    expect(checkboxes[3].checked).toBe(false); // D: bit 3 not set
  });

  it('calls onCommit with bit cleared when unchecking A', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={0b0101} meta={flagMeta} editMode={true} onCommit={onCommit} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // uncheck A (bit 0)
    expect(onCommit).toHaveBeenCalledWith(0b0100);
  });

  it('calls onCommit with bit set when checking B', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={0b0101} meta={flagMeta} editMode={true} onCommit={onCommit} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // check B (bit 1)
    expect(onCommit).toHaveBeenCalledWith(0b0111);
  });
});

describe('FlagCell — missing enumBitValues guard (V4)', () => {
  it('renders nothing when isBitmask but enumBitValues is absent', () => {
    const nobitsMeta: FieldMetadata = {
      name: 'NoData', type: 'enum', isArray: false,
      validFormKeyTypes: [], enumValues: ['A', 'B'],
      isBitmask: true,
      // enumBitValues deliberately absent
    };
    const { container } = render(
      <FlagCell value={3} meta={nobitsMeta} editMode={true} onCommit={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('FlagCell — sparse bit positions (F1)', () => {
  it('read: shows X and Z active for value 5 using actual bit values', () => {
    // With 1<<index: index 1 → bit 1, but Z is actually bit 4. Would show only X.
    // With enumBitValues [1, 4]: X=1 (5&1≠0), Z=4 (5&4≠0) → both active.
    render(<FlagCell value={5} meta={sparseFlags} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('X, Z')).toBeInTheDocument();
  });

  it('edit: both checkboxes checked when value has bits 1 and 4 set', () => {
    render(<FlagCell value={5} meta={sparseFlags} editMode={true} onCommit={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0].checked).toBe(true);   // X: 5 & 1 !== 0
    expect(checkboxes[1].checked).toBe(true);   // Z: 5 & 4 !== 0
  });

  it('edit: onCommit uses enumBitValues[i] not 1<<i when toggling Z', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={5} meta={sparseFlags} editMode={true} onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // toggle Z (bit 4)
    // 5 ^ 4 = 1; wrong answer with 1<<index would be 5 ^ 2 = 7
    expect(onCommit).toHaveBeenCalledWith(1);
  });
});
