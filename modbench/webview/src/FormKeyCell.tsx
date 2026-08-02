import React, { useState } from 'react';
import { pickFormKey } from './nativeBridge';
import { FormKeyLink, formKeyLabel } from './FormKeyLink';
import { ReadOnlyValueSurface } from './ReadOnlyValueSurface';
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
  // Issue #201: only ever true on an immutable column — a mutable one hands plain click to the
  // QuickPick, which is itself a native input and so already the text surface this state exists
  // to provide.
  const [active, setActive] = useState(false);

  // Issue #111: the cell reads the same whether or not its column is editable — a FormKey is a
  // link, not a form control. Editability shows up in the gesture, not the paint: plain click
  // opens the picker only where the column is mutable, and Ctrl+click follows the reference
  // everywhere (including read-only columns).
  // Issue #210: the picker itself is a native QuickPick (only the extension host can call
  // vscode.window.createQuickPick), seeded with the current reference — pickFormKey resolves to
  // the picked FormKey, or null on Escape/blur, in which case the field is left unchanged.
  // Issue #201 / ADR-0033: on an immutable column plain click activates the read-only surface —
  // previously it did nothing at all, which is why #218's composite label was correct and still
  // unreachable. Ctrl+click is unaffected: FormKeyLink routes that to onOpen and never calls
  // onPlainClick, so following a reference cannot leave a surface open behind the record opened.
  // A null reference offers nothing to select, so it activates nothing (the `—` placeholder rule).
  function onPlainClick() {
    if (editable) {
      void pickFormKey(fk ?? '', meta.validFormKeyTypes).then(picked => { if (picked) onCommit(picked); });
      return;
    }
    if (fk !== null) setActive(true);
  }

  function renderValue() {
    // Issue #201 / #204: no cursor override on the placeholder — the parent DiskCell's `grab` is
    // the resting affordance here as everywhere else in the grid.
    if (fk === null) return <span onClick={onPlainClick} style={{ opacity: 0.35 }}>—</span>;
    if (active) return <ReadOnlyValueSurface value={formKeyLabel(fk, resolution)} onBlur={() => setActive(false)} />;
    return <FormKeyLink value={fk} onOpen={onOpen} onPlainClick={onPlainClick} resolution={resolution} />;
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {renderValue()}
      <CheckErrorIcon checkError={checkError} />
    </span>
  );
}
