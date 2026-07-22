import React, { useState } from 'react';
import { FormKeyPicker } from './FormKeyPicker';
import { FormKeyLink } from './FormKeyLink';
import { CheckErrorIcon } from './CheckErrorIcon';
import type { FieldMetadata, FormKeyResolution } from './types';
import type { RecordSessionClient } from './RecordSessionClient';

interface FormKeyCellProps {
  value: unknown;
  meta: FieldMetadata;
  editable: boolean;
  client: RecordSessionClient;
  onOpen: (fk: string) => void;
  onCommit: (fk: string) => void;
  checkError?: string | null;
  // ADR-0031 / issue #157: the leaf's own resolution signal, gating the link affordance and
  // label — independent of checkError, which still drives the ⚠ icon below but no longer the
  // link (a resolved-but-wrong-type reference carries a checkError yet is still followable).
  resolution?: FormKeyResolution;
}

export function FormKeyCell({ value, meta, editable, client, onOpen, onCommit, checkError, resolution }: FormKeyCellProps) {
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <FormKeyPicker
        client={client}
        validTypes={meta.validFormKeyTypes}
        onSelect={fk => { setPicking(false); onCommit(fk); }}
        onClose={() => setPicking(false)}
      />
    );
  }

  // Issue #111: the cell reads the same whether or not its column is editable — a FormKey is a
  // link, not a form control. Editability shows up in the gesture, not the paint: plain click
  // opens the picker only where the column is mutable, and Ctrl+click follows the reference
  // everywhere (including read-only columns).
  const onPlainClick = editable ? () => setPicking(true) : undefined;

  const fk = typeof value === 'string' && value ? value : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {fk === null
        ? (
          <span
            onClick={onPlainClick}
            style={{ opacity: 0.35, cursor: editable ? 'pointer' : undefined }}
          >—</span>
        )
        : <FormKeyLink value={fk} onOpen={onOpen} onPlainClick={onPlainClick} resolution={resolution} />}
      <CheckErrorIcon checkError={checkError} />
    </span>
  );
}
