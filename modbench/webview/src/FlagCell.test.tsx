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
    expect(onCommit).toHaveBeenCalledWith('4'); // 0b0101 ^ 0b0001 = 0b0100
  });

  it('calls onCommit with bit set when checking B', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={0b0101} meta={flagMeta} editMode={true} onCommit={onCommit} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // check B (bit 1)
    expect(onCommit).toHaveBeenCalledWith('7'); // 0b0101 ^ 0b0010 = 0b0111
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

describe('FlagCell — high-bit flags (BigInt arithmetic)', () => {
  // Race.Flag has LowPriorityPushable = 2^53 and CannotUsePlayableItems = 2^54.
  // JS bitwise ops (& ^ |) coerce operands to ToInt32, zeroing bits 32+.
  // enumBitValues are strings so the frontend can parse them as BigInt.
  const highBitMeta: FieldMetadata = {
    name: 'RaceFlags',
    type: 'enum',
    isArray: false,
    validFormKeyTypes: [],
    enumValues: ['Playable', 'LowPriorityPushable'],
    enumBitValues: ['1', '9007199254740992'],  // 2^0, 2^53
    isBitmask: true,
  };

  it('read: shows LowPriorityPushable as active when value is 2^53', () => {
    render(<FlagCell value={9007199254740992} meta={highBitMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('LowPriorityPushable')).toBeInTheDocument();
  });

  it('edit: checkbox for LowPriorityPushable is checked when value is 2^53', () => {
    render(<FlagCell value={9007199254740992} meta={highBitMeta} editMode={true} onCommit={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0].checked).toBe(false);  // Playable: not set
    expect(checkboxes[1].checked).toBe(true);   // LowPriorityPushable: set
  });

  it('edit: toggling LowPriorityPushable when it is the only flag calls onCommit with 0', () => {
    const onCommit = vi.fn();
    render(<FlagCell value={9007199254740992} meta={highBitMeta} editMode={true} onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // uncheck LowPriorityPushable
    expect(onCommit).toHaveBeenCalledWith('0');
  });

  const bit32Meta: FieldMetadata = {
    name: 'RaceFlags2',
    type: 'enum',
    isArray: false,
    validFormKeyTypes: [],
    enumValues: ['Playable', 'UseAdvancedAvoidance'],
    enumBitValues: ['1', '4294967296'],  // 2^0, 2^32
    isBitmask: true,
  };

  it('read: bit-32 flag shows as active when value equals 2^32', () => {
    render(<FlagCell value={4294967296} meta={bit32Meta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('UseAdvancedAvoidance')).toBeInTheDocument();
  });

  it('edit: toggling bit-32 flag does not corrupt lower bits already set', () => {
    // value = 2^32 + 1 (UseAdvancedAvoidance | Playable)
    // unchecking UseAdvancedAvoidance should leave Playable (= 1), not 0
    const onCommit = vi.fn();
    render(<FlagCell value={4294967297} meta={bit32Meta} editMode={true} onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // uncheck UseAdvancedAvoidance
    expect(onCommit).toHaveBeenCalledWith('1');
  });
});

describe('FlagCell — string value contract (TD-008)', () => {
  const highBitMeta: FieldMetadata = {
    name: 'RaceFlags',
    type: 'enum',
    isArray: false,
    validFormKeyTypes: [],
    enumValues: ['Playable', 'LowPriorityPushable'],
    enumBitValues: ['1', '9007199254740992'],  // 2^0, 2^53
    isBitmask: true,
  };

  it('read: parses a decimal string above 2^53 without losing the low bit', () => {
    // 2^53 + 1: Number("9007199254740993") rounds to 2^53 and drops Playable.
    // BigInt("9007199254740993") keeps both bits.
    render(<FlagCell value="9007199254740993" meta={highBitMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Playable, LowPriorityPushable')).toBeInTheDocument();
  });

  it('edit: onCommit receives a decimal string preserving precision above 2^53', () => {
    const onCommit = vi.fn();
    render(<FlagCell value="9007199254740992" meta={highBitMeta} editMode={true} onCommit={onCommit} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]); // check Playable (bit 0)
    expect(onCommit).toHaveBeenCalledWith('9007199254740993');
  });

  it('does not throw on a non-numeric string value; renders as no flags', () => {
    render(<FlagCell value="abc" meta={flagMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('does not throw on a non-numeric, non-string value; renders as no flags', () => {
    render(<FlagCell value={{}} meta={flagMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
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
    expect(onCommit).toHaveBeenCalledWith('1');
  });
});
