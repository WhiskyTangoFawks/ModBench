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
  enumBitValues: ['1', '2', '4', '8'],
  isBitmask: true,
};

const sparseFlags: FieldMetadata = {
  name: 'SparseFlags',
  type: 'enum',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: ['X', 'Z'],
  enumBitValues: ['1', '4'],   // non-sequential: Z is bit 4, not bit 1
  isBitmask: true,
};

// Maintainer ruling 2026-09-01 (deliberate ADR-0034 divergence, recorded there): the
// checkbox list IS the cell — always visible, one checkbox per flag, no gesture to
// reveal it. The former text-until-clicked render and its focus/open gating (#223) are gone.
describe('FlagCell — always-visible checkbox list', () => {
  it('renders one checkbox per flag with correct checked state, no click needed', () => {
    render(<FlagCell value={0b0101} meta={flagMeta} editable onCommit={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toBeChecked();      // A
    expect(boxes[1]).not.toBeChecked();  // B
    expect(boxes[2]).toBeChecked();      // C
    expect(boxes[3]).not.toBeChecked();  // D
  });

  it('labels every checkbox with its flag name', () => {
    render(<FlagCell value={0} meta={flagMeta} editable onCommit={vi.fn()} />);
    for (const name of flagMeta.enumValues) expect(screen.getByText(name)).toBeInTheDocument();
  });

  it('zero renders the full list all-unchecked, not a placeholder', () => {
    render(<FlagCell value={0} meta={flagMeta} editable onCommit={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

describe('FlagCell — collapsed row', () => {
  it('renders the compact flag-name summary instead of checkboxes', () => {
    render(<FlagCell value={0b0101} meta={flagMeta} editable onCommit={vi.fn()} collapsed />);
    expect(screen.getByText('A, C')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders "—" when no flags are set', () => {
    render(<FlagCell value={0} meta={flagMeta} editable onCommit={vi.fn()} collapsed />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('FlagCell — read-only column', () => {
  it('renders the same checkbox list, disabled', () => {
    render(<FlagCell value={0b0101} meta={flagMeta} editable={false} onCommit={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    for (const box of boxes) expect(box).toBeDisabled();
    expect(boxes[0]).toBeChecked();
  });

  it('clicking a disabled checkbox never commits', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={0b0101} meta={flagMeta} editable={false} onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('renders "—" for null value — a placeholder, not an all-unchecked list', () => {
    render(<FlagCell value={null} meta={flagMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('FlagCell — null on a writable column', () => {
  // A writable column's null still offers the list (all unchecked) — the old
  // text-until-clicked render let a click set flags from null, and that capability survives.
  it('renders the all-unchecked list and can set the first flag', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={null} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onCommit).toHaveBeenCalledWith('1');
  });
});

describe('FlagCell — editing', () => {
  it('calls onCommit with bit cleared when unchecking A', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={0b0101} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onCommit).toHaveBeenCalledWith(String(0b0100));
  });

  it('calls onCommit with bit set when checking B', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={0b0101} meta={flagMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).toHaveBeenCalledWith(String(0b0111));
  });
});

describe('FlagCell — missing enumBitValues guard (V4)', () => {
  it('renders nothing when isBitmask but enumBitValues is absent', () => {
    const meta = { ...flagMeta, enumBitValues: undefined };
    const { container } = render(<FlagCell value={3} meta={meta} editable onCommit={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FlagCell — high-bit flags (BigInt arithmetic)', () => {
  const highMeta: FieldMetadata = {
    ...flagMeta,
    enumValues: ['Low', 'LowPriorityPushable'],
    enumBitValues: ['1', String(2 ** 53)],
  };

  it('checkbox for LowPriorityPushable is checked when value is 2^53', () => {
    render(<FlagCell value={String(2 ** 53)} meta={highMeta} editable onCommit={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')[1]).toBeChecked();
  });

  it('toggling LowPriorityPushable when it is the only flag calls onCommit with 0', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={String(2 ** 53)} meta={highMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).toHaveBeenCalledWith('0');
  });

  const bit32Meta: FieldMetadata = {
    ...flagMeta,
    enumValues: ['Low', 'Bit32'],
    enumBitValues: ['1', String(2 ** 32)],
  };

  it('bit-32 checkbox is checked when value equals 2^32', () => {
    render(<FlagCell value={2 ** 32} meta={bit32Meta} editable onCommit={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')[1]).toBeChecked();
  });

  it('toggling bit-32 flag does not corrupt lower bits already set', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={(2 ** 32) + 1} meta={bit32Meta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).toHaveBeenCalledWith('1');
  });
});

describe('FlagCell — string value contract (TD-008)', () => {
  const highMeta: FieldMetadata = {
    ...flagMeta,
    enumValues: ['Low', 'High'],
    enumBitValues: ['1', String(2 ** 53)],
  };

  it('parses a decimal string above 2^53 without losing the low bit', () => {
    render(<FlagCell value={(BigInt(2 ** 53) + 1n).toString()} meta={highMeta} editable onCommit={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  it('onCommit receives a decimal string preserving precision above 2^53', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={(BigInt(2 ** 53) + 1n).toString()} meta={highMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onCommit).toHaveBeenCalledWith(BigInt(2 ** 53).toString());
  });

  it('does not throw on a non-numeric string value; renders all-unchecked', () => {
    render(<FlagCell value="not-a-number" meta={flagMeta} editable onCommit={vi.fn()} />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it('does not throw on a non-numeric, non-string value; renders all-unchecked', () => {
    render(<FlagCell value={{ weird: true }} meta={flagMeta} editable onCommit={vi.fn()} />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });
});

describe('FlagCell — sparse bit positions (F1)', () => {
  it('X and Z both checked for value 5 using actual bit values', () => {
    render(<FlagCell value={5} meta={sparseFlags} editable onCommit={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  it('onCommit uses enumBitValues[i] not 1<<i when toggling Z', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={5} meta={sparseFlags} editable onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onCommit).toHaveBeenCalledWith('1'); // 5 ^ 4
  });
});
