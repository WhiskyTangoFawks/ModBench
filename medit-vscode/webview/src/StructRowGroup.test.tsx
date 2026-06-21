import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StructRowGroup } from './StructRowGroup';
import type { FieldMetadata } from './types';

const factionMeta: FieldMetadata = {
  name: 'factions_element',
  type: 'struct',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: [],
  fields: [
    { name: 'faction', type: 'formKey', isArray: false, validFormKeyTypes: ['fact'], enumValues: [] },
    { name: 'rank',    type: 'int',     isArray: false, validFormKeyTypes: [],       enumValues: [] },
  ],
};

describe('StructRowGroup', () => {
  it('shows {…} when collapsed', () => {
    render(<StructRowGroup value={{ faction: '000010:Fallout4.esm', rank: 1 }}
      meta={factionMeta} editMode={false} port={5172}
      onOpen={vi.fn()} onCommit={vi.fn()} storageKey="test:struct" />);
    expect(screen.getByText('{…}')).toBeInTheDocument();
  });

  it('expands to show sub-fields from schema, not just stored keys', () => {
    // Value is missing 'rank' — sub-schema should still show the row
    render(<StructRowGroup value={{ faction: '000010:Fallout4.esm' }}
      meta={factionMeta} editMode={false} port={5172}
      onOpen={vi.fn()} onCommit={vi.fn()} storageKey="test:struct2" />);
    fireEvent.click(screen.getByText('{…}'));
    expect(screen.getByText('faction')).toBeInTheDocument();
    expect(screen.getByText('rank')).toBeInTheDocument();
  });

  it('shows correct cell type for int sub-field', () => {
    render(<StructRowGroup value={{ faction: '000010:Fallout4.esm', rank: 3 }}
      meta={factionMeta} editMode={false} port={5172}
      onOpen={vi.fn()} onCommit={vi.fn()} storageKey="test:struct3" />);
    fireEvent.click(screen.getByText('{…}'));
    // rank value 3 should be visible
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders FlagCell checkboxes (not a select) for bitmask enum sub-field (V3)', () => {
    const structWithFlagsMeta: FieldMetadata = {
      name: 'struct_with_flags', type: 'struct', isArray: false,
      validFormKeyTypes: [], enumValues: [],
      fields: [{
        name: 'mode_flags', type: 'enum', isArray: false,
        validFormKeyTypes: [], enumValues: ['A', 'B', 'C'],
        enumBitValues: ['1', '2', '4'], isBitmask: true,
      }],
    };
    render(<StructRowGroup value={{ mode_flags: 5 }}
      meta={structWithFlagsMeta} editMode={true} port={5172}
      onOpen={vi.fn()} onCommit={vi.fn()} storageKey="test:struct-flags" />);
    fireEvent.click(screen.getByText('{…}'));
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0].checked).toBe(true);   // A: 5 & 1 !== 0
    expect(checkboxes[1].checked).toBe(false);  // B: 5 & 2 === 0
    expect(checkboxes[2].checked).toBe(true);   // C: 5 & 4 !== 0
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('calls onCommit with merged struct when sub-field changes', () => {
    const onCommit = vi.fn();
    render(<StructRowGroup value={{ faction: '000010:Fallout4.esm', rank: 1 }}
      meta={factionMeta} editMode={true} port={5172}
      onOpen={vi.fn()} onCommit={onCommit} storageKey="test:struct4" />);
    fireEvent.click(screen.getByText('{…}'));
    const input = screen.getByDisplayValue('1');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ faction: '000010:Fallout4.esm', rank: 5 })
    );
  });
});
