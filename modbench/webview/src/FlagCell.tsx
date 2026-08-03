import React, { useState } from 'react';
import { ReadOnlyValueSurface } from './ReadOnlyValueSurface';
import { modelValue, toBigInt } from './modelValue';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  editable: boolean;
  // Issue #223 / ADR-0034: see ScalarCell's identical prop for the full rationale — gates the
  // mutable branch's plain click; unused by the immutable branch (untouched by this ticket).
  // Optional, defaulting to `true`, for the same reason ScalarCell's does: a caller outside the
  // field grid's focus model (none render FlagCell today, but keeping the contract identical
  // across the three leaves avoids a silent trap for the next one that does).
  isFocused?: boolean;
  onCommit: (v: unknown) => void;
}

export function FlagCell({ value, meta, editable, isFocused = true, onCommit }: FlagCellProps) {
  // Issue #111: only the clicked cell becomes a multi-select; the rest of the grid stays text.
  const [active, setActive] = useState(false);

  if (meta.enumValues.length === 0) return null;
  if (!meta.enumBitValues) return null;

  // BigInt arithmetic avoids ToInt32 truncation for flags at bit 32+ and keeps full precision
  // for high bits. onCommit emits a decimal string so the toggled value round-trips losslessly.
  const num = toBigInt(value);
  const bits = meta.enumBitValues.map(BigInt);

  // Issue #201 / #224: the active flag *names* are what this cell displays, so they are what it
  // has to be able to hand over — the bitmask integer behind them is not something the user ever
  // saw. Sourced from modelValue (the same string Ctrl+C copies, AC6) rather than computed again
  // here. Null and "no bits set" both render `—`, a placeholder rather than a value, and collapse
  // to the same null here so neither offers a surface (ADR-0033's struct/array exception) —
  // modelValue already collapses both to '', so only the empty-string check is needed here.
  const namesStr = modelValue(value, meta);
  const names = namesStr === '' ? null : namesStr;

  if (!active) {
    const text = names === null
      ? <span style={{ opacity: 0.35 }}>—</span>
      : <span>{names}</span>;
    if (!editable) {
      if (names === null) return text;
      // Issue #223: untouched by this ticket, same as ScalarCell's immutable branch — plain
      // click keeps activating the read-only surface unconditionally until #226 (which depends
      // on #224 shipping Ctrl+C as the replacement copy path first). No `data-open-trigger`
      // here, so F2 correctly does nothing on this branch, as it always has.
      return <span onClick={() => setActive(true)}>{text}</span>;
    }
    // Issue #201 / #204 / ADR-0033: no cursor override — the parent DiskCell's `grab` is this
    // cell's resting affordance, since it is a drag source the whole time. The `pointer` that
    // used to be here advertised the click and painted over the drag, which is the same false
    // promise #204 removed from ScalarCell and #218 removed from FormKeyLink.
    // Issue #223 / ADR-0034: mutable columns gate opening behind xEdit's three triggers — see
    // ScalarCell's identical branch for the full rationale.
    return (
      <span
        data-open-trigger
        onClick={() => { if (isFocused) setActive(true); }}
        onDoubleClick={() => setActive(true)}
      >{text}</span>
    );
  }

  // Issue #201: an immutable column activates a read-only surface instead of the multi-select.
  if (!editable) return <ReadOnlyValueSurface value={names ?? ''} onBlur={() => setActive(false)} />;

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
