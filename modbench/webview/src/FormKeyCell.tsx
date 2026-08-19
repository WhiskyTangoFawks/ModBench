import React from 'react';
import { FormKeyLink } from './FormKeyLink';
import { CheckErrorIcon } from './CheckErrorIcon';
import type { FieldMetadata, FormKeyResolution } from './types';

interface FormKeyCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Issue #223 / ADR-0034: whether this is the panel's single focused cell. Kept (unused by the
  // read paths below) so the grid's focus contract stays uniform across every leaf.
  isFocused?: boolean;
  onOpen: (fk: string) => void;
  checkError?: string | null;
  // ADR-0031 / issue #157: the leaf's own resolution signal, gating the link affordance and
  // label — independent of checkError, which still drives the ⚠ icon below but no longer the
  // link (a resolved-but-wrong-type reference carries a checkError yet is still followable).
  resolution?: FormKeyResolution;
}

// #410/ADR-0041: read-only. The FormKey picker this cell opened staged a pending change through
// an endpoint that is gone. Following a reference survives untouched — Ctrl+click is a read, and
// it is how the compare grid is navigated.
export function FormKeyCell({ value, onOpen, checkError, resolution }: FormKeyCellProps) {
  const fk = typeof value === 'string' && value ? value : null;

  function renderValue() {
    if (fk === null) {
      return <span style={{ opacity: 0.35 }}>—</span>;
    }
    return <FormKeyLink value={fk} onOpen={onOpen} resolution={resolution} />;
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {renderValue()}
      <CheckErrorIcon checkError={checkError} />
    </span>
  );
}
