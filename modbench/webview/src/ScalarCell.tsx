import React from 'react';
import { modelValue } from './modelValue';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Issue #205: an accessible name for the resting cell, so tests (and screen readers) can
  // address one cell among many identical-looking ones.
  ariaLabel?: string;
  // Issue #165: replaces the resting label alone — the value Ctrl+C copies is still the real
  // model value.
  displayOverride?: string;
}

function ScalarText({ value, meta, displayOverride, ariaLabel }: {
  value: unknown; meta: FieldMetadata; displayOverride?: string; ariaLabel?: string;
}) {
  if (displayOverride != null) return <span aria-label={ariaLabel}>{displayOverride}</span>;
  return value == null
    ? <span aria-label={ariaLabel} style={{ opacity: 0.35 }}>—</span>
    : <span aria-label={ariaLabel}>{modelValue(value, meta)}</span>;
}

// #410/ADR-0041: read-only. Every editing branch this component carried (the inline input, the
// second-click/F2/double-click open triggers, the extended-editor redirect) staged through a
// backend endpoint that no longer exists. What survives is what a viewer needs: the resting text,
// which is also exactly the string Ctrl+C copies (DiskCell/DiffRow own that gesture).
export function ScalarCell({ value, meta, ariaLabel, displayOverride }: ScalarCellProps) {
  return <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />;
}
