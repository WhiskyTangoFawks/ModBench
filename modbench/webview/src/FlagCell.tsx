import React from 'react';
import { modelValue } from './modelValue';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
}

// #410/ADR-0041: read-only. The multi-select editor and its open triggers retired with the write
// path they staged through; the active flag names are what this cell shows and what Ctrl+C copies.
export function FlagCell({ value, meta }: FlagCellProps) {
  if (meta.enumValues.length === 0) return null;
  if (!meta.enumBitValues) return null;

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

  return text;
}
