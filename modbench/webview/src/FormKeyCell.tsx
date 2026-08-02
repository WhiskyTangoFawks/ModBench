import React from 'react';
import { pickFormKey } from './nativeBridge';
import { FormKeyLink } from './FormKeyLink';
import { CheckErrorIcon } from './CheckErrorIcon';
import type { FieldMetadata, FormKeyResolution } from './types';

interface FormKeyCellProps {
  value: unknown;
  meta: FieldMetadata;
  editable: boolean;
  onOpen: (fk: string) => void;
  onCommit: (fk: string) => void;
  checkError?: string | null;
  // ADR-0031 / issue #157: the leaf's own resolution signal, gating the link affordance and
  // label — independent of checkError, which still drives the ⚠ icon below but no longer the
  // link (a resolved-but-wrong-type reference carries a checkError yet is still followable).
  resolution?: FormKeyResolution;
}

export function FormKeyCell({ value, meta, editable, onOpen, onCommit, checkError, resolution }: FormKeyCellProps) {
  const fk = typeof value === 'string' && value ? value : null;

  // Issue #111: the cell reads the same whether or not its column is editable — a FormKey is a
  // link, not a form control. Editability shows up in the gesture, not the paint: plain click
  // opens the picker only where the column is mutable, and Ctrl+click follows the reference
  // everywhere (including read-only columns).
  // Issue #210: the picker itself is a native QuickPick (only the extension host can call
  // vscode.window.createQuickPick), seeded with the current reference — pickFormKey resolves to
  // the picked FormKey, or null on Escape/blur, in which case the field is left unchanged.
  const onPlainClick = editable
    ? () => { void pickFormKey(fk ?? '', meta.validFormKeyTypes).then(picked => { if (picked) onCommit(picked); }); }
    : undefined;

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
