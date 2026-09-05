import React from 'react';
import { flagNames } from './modelValue';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Whether this cell's column can be written — presence of somewhere to write is the
  // editability signal (see ScalarCell's identical contract).
  editable?: boolean;
  // The names now set, as the document spells a flags member. Optional: a caller with nowhere to
  // write renders read-only rather than crashing.
  onCommit?: (v: unknown) => void;
  // The row's collapse state (the grid's chevron/double-click gesture, owned by the row —
  // all columns collapse together): collapsed shows the compact set-name summary, xEdit's own
  // at-rest render.
  collapsed?: boolean;
}

/** A `flags` member renders as an always-visible checkbox list — a deliberate ADR-0034
 *  divergence from xEdit, whose `etCheckComboBox` appears only on the edit gesture. There is no
 *  text state and nothing to open, so F2 is inert. */
export function FlagCell({ value, meta, editable, onCommit, collapsed }: FlagCellProps) {
  // Absent means default: no names set.
  const names = flagNames(value);

  if (collapsed) return <span>{names.join(', ')}</span>;

  const writable = editable && onCommit != null;
  // A name the metadata does not list stays where the document put it; only the toggled name moves.
  const toggle = (name: string) =>
    onCommit?.(names.includes(name) ? names.filter(n => n !== name) : [...names, name]);

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {meta.enumMembers.map(({ value: name }) => (
        <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            type="checkbox"
            checked={names.includes(name)}
            disabled={!writable}
            onChange={writable ? () => toggle(name) : undefined}
          />
          {name}
        </label>
      ))}
    </span>
  );
}
