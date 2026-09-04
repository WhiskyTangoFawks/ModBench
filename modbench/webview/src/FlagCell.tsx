import React from 'react';
import { flagBits, modelValue, toBigInt } from './modelValue';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Whether this cell's column can be written — presence of somewhere to write is the
  // editability signal (see ScalarCell's identical contract).
  editable?: boolean;
  // A decimal string, per modelValue's own flags convention, so precision above 2^53 survives the
  // wire. Optional: a caller with nowhere to write renders read-only rather than crashing.
  onCommit?: (v: unknown) => void;
  // The row's collapse state (the grid's chevron/double-click gesture, owned by the row —
  // all columns collapse together): collapsed shows the compact active-flag-name summary,
  // xEdit's own at-rest render.
  collapsed?: boolean;
}

/** A bitmask `enum` column renders as an always-visible checkbox list — a deliberate ADR-0034
 *  divergence from xEdit, whose `etCheckComboBox` appears only on the edit gesture. There is no
 *  text state and nothing to open, so F2 is inert. */
export function FlagCell({ value, meta, editable, onCommit, collapsed }: FlagCellProps) {
  const bits = flagBits(meta);
  if (bits == null) return null;

  if (collapsed) {
    // modelValue collapses null and no-bits-set alike to '' — both render the placeholder.
    const names = modelValue(value, meta);
    return names === ''
      ? <span style={{ opacity: 0.35 }}>—</span>
      : <span>{names}</span>;
  }

  // Null is a column that doesn't hold the field — a placeholder, not an all-unchecked value
  // (ADR-0034), except on a writable column, where the all-unchecked list lets a click set flags
  // starting from null.
  const writable = editable && onCommit != null;
  if (value == null && !writable) return <span style={{ opacity: 0.35 }}>—</span>;

  // BigInt arithmetic avoids ToInt32 truncation for flags at bit 32+ and keeps full precision
  // for high bits. onCommit emits a decimal string so the toggled value round-trips losslessly.
  const num = toBigInt(value);

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {bits.map(({ value: name, bit }) => (
        <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            type="checkbox"
            checked={(num & bit) !== 0n}
            disabled={!writable}
            onChange={writable ? () => onCommit(String(num ^ bit)) : undefined}
          />
          {name}
        </label>
      ))}
    </span>
  );
}
