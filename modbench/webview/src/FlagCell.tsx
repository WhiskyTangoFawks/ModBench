import React from 'react';
import { modelValue, toBigInt } from './modelValue';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Whether this cell's column can be written — presence of somewhere to write is the
  // editability signal (see ScalarCell's identical contract).
  editable?: boolean;
  // Where a toggled bitmask goes — mirrors ScalarCell's onCommit contract exactly (a decimal
  // string, per modelValue's own flags convention, so precision above 2^53 survives the wire).
  // Optional for the same reason ScalarCell's is: a caller with nowhere to write (outside the
  // field grid's focus model) renders read-only rather than crashing.
  onCommit?: (v: unknown) => void;
  // The row's collapse state (the grid's chevron/double-click gesture, owned by the row —
  // all columns collapse together): collapsed shows the compact active-flag-name summary,
  // xEdit's own at-rest render.
  collapsed?: boolean;
}

/**
 * A bitmask `enum` column renders as an always-visible checkbox list, one flag per line —
 * maintainer ruling 2026-09-01, a deliberate ADR-0034 divergence recorded there (xEdit's own
 * default is a text row whose `etCheckComboBox` appears only on the edit gesture). There is no
 * text state and nothing to open: no `data-open-trigger`, so F2 is inert here by construction
 * (DiskCell's rule), and Ctrl+C still copies modelValue's flag-name string via DiskCell.
 */
export function FlagCell({ value, meta, editable, onCommit, collapsed }: FlagCellProps) {
  if (meta.enumValues.length === 0) return null;
  if (!meta.enumBitValues) return null;

  if (collapsed) {
    // modelValue collapses null and no-bits-set alike to '' — both render the placeholder.
    const names = modelValue(value, meta);
    return names === ''
      ? <span style={{ opacity: 0.35 }}>—</span>
      : <span>{names}</span>;
  }

  // Null is a column that doesn't hold the field — a placeholder, not an all-unchecked value
  // (ADR-0034's placeholder rule)… except on a writable column, where the old text render let a
  // click set flags starting from null; the all-unchecked list preserves that capability.
  const writable = editable && onCommit != null;
  if (value == null && !writable) return <span style={{ opacity: 0.35 }}>—</span>;

  // BigInt arithmetic avoids ToInt32 truncation for flags at bit 32+ and keeps full precision
  // for high bits. onCommit emits a decimal string so the toggled value round-trips losslessly.
  const num = toBigInt(value);
  const bits = meta.enumBitValues.map(BigInt);

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {meta.enumValues.map((name, i) => (
        <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            type="checkbox"
            checked={(num & bits[i]) !== 0n}
            disabled={!writable}
            onChange={writable ? () => onCommit(String(num ^ bits[i])) : undefined}
          />
          {name}
        </label>
      ))}
    </span>
  );
}
