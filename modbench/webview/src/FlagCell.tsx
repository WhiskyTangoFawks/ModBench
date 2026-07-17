import React, { useState } from 'react';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  editable: boolean;
  onCommit: (v: unknown) => void;
}

// Bitmask values arrive as decimal strings (the backend's contract — see Models.cs) so combined
// flags above 2^53 survive JSON without IEEE 754 loss. Numbers are still accepted for small values.
// Anything else (or a malformed string) yields 0n rather than throwing on BigInt(NaN).
function toBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'string') return BigInt(value);
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  } catch {
    /* malformed numeric string — fall through to 0n */
  }
  return 0n;
}

export function FlagCell({ value, meta, editable, onCommit }: FlagCellProps) {
  // Issue #111: only the clicked cell becomes a multi-select; the rest of the grid stays text.
  const [active, setActive] = useState(false);

  if (meta.enumValues.length === 0) return null;
  if (!meta.enumBitValues) return null;

  // BigInt arithmetic avoids ToInt32 truncation for flags at bit 32+ and keeps full precision
  // for high bits. onCommit emits a decimal string so the toggled value round-trips losslessly.
  const num = toBigInt(value);
  const bits = meta.enumBitValues.map(BigInt);

  if (!editable || !active) {
    const text = value == null
      ? <span style={{ opacity: 0.35 }}>—</span>
      : <span>{meta.enumValues.filter((_, i) => (num & bits[i]) !== 0n).join(', ') || '—'}</span>;
    return editable
      ? <span onClick={() => setActive(true)} style={{ cursor: 'pointer' }}>{text}</span>
      : text;
  }

  return (
    // The multi-select is a group, so it closes when focus leaves the group as a whole — not
    // when it moves between the flags inside it.
    <span
      tabIndex={-1}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setActive(false); }}
      style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', outline: 'none' }}
    >
      {meta.enumValues.map((name, i) => (
        <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            type="checkbox"
            checked={(num & bits[i]) !== 0n}
            onChange={() => onCommit(String(num ^ bits[i]))}
          />
          {name}
        </label>
      ))}
    </span>
  );
}
