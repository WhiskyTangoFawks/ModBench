import React, { useState } from 'react';
import { modelValue, toBigInt } from './modelValue';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  // #415/#426: whether this cell's column can be written — presence of somewhere to write is the
  // editability signal (see ScalarCell's identical contract).
  editable?: boolean;
  // Issue #223 / ADR-0034: gates the plain click, so a *second* click on an already-focused cell
  // opens while a first click only focuses.
  isFocused?: boolean;
  // #426: where a toggled bitmask goes — mirrors ScalarCell's onCommit contract exactly (a decimal
  // string, per modelValue's own flags convention, so precision above 2^53 survives the wire).
  // Optional for the same reason ScalarCell's is: a caller with nowhere to write (outside the
  // field grid's focus model) renders read-only rather than crashing.
  onCommit?: (v: unknown) => void;
}

/**
 * #426: restores xEdit's inline check-combo (`etCheckComboBox`) for a bitmask `enum` column — the
 * one editor type that was never a native surface (ADR-0034 permits only the FormKey picker and
 * the extended editor as vehicle substitutions; flags stay exactly what xEdit already renders
 * inline). Ported verbatim from before #410 (git history `b1992bf~1`), retargeted at the #415
 * write path's `onCommit` contract — the multi-select's own toggle logic is unchanged.
 */
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

  const text = names === null
    ? <span style={{ opacity: 0.35 }}>—</span>
    : <span>{names}</span>;

  // Issue #226 / ADR-0034: an immutable column simply refuses — no multi-select, no distinct
  // affordance beforehand. Checked ahead of `active` since there is no state to gate: click,
  // second click, F2 and double click all land here and do nothing. Copy is Ctrl+C on the
  // focused, unopened cell (#224), sourced from the same modelValue string as `names` above.
  if (!editable || !onCommit) return text;

  if (!active) {
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
