import React from 'react';
import { pickFormKey } from './nativeBridge';
import { FormKeyLink, formKeyLabel } from './FormKeyLink';
import { CheckErrorIcon } from './CheckErrorIcon';
import type { FieldMetadata, FormKeyResolution } from './types';

interface FormKeyCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Optional, defaulting to non-editable — matches ScalarCell/FlagCell's contract
  // (presence of somewhere to write is the editability signal). A VMAD composite leaf that
  // composes this cell but has no write path of its own simply omits it.
  editable?: boolean;
  // ADR-0018: gates the mutable branch's plain-click open of the QuickPick. Optional, defaulting
  // to `true`, so a caller outside the field grid's focus model need not pass it.
  isFocused?: boolean;
  onOpen: (fk: string) => void;
  // Optional for the same reason `editable` is — `onPlainClick`/`openPicker` are gated on
  // `editable` before `onCommit` is ever reached.
  onCommit?: (fk: string) => void;
  checkError?: string | null;
  // ADR-0005: the leaf's own resolution signal gates the link affordance and label, independent of
  // checkError — a resolved-but-wrong-type reference carries a checkError yet is still followable.
  resolution?: FormKeyResolution;
}

/** ADR-0018's divergence #1: a native QuickPick rather than an in-webview control, because the
 *  webview cannot host a searchable record list as well as VS Code already does. */
export function FormKeyCell({ value, meta, editable, isFocused = true, onOpen, onCommit, checkError, resolution }: FormKeyCellProps) {
  const fk = typeof value === 'string' && value ? value : null;

  // Split out so both the gated plain-click path and the unconditional double-click path share it.
  function openPicker() {
    // Seeded with the composite this cell displays, not the bare FormKey — the picker's native
    // input is where a mutable cell's value is selected and copied. The picker normalizes a
    // composite back to its reference before searching.
    void pickFormKey(fk ? formKeyLabel(fk, resolution) : '', meta.validFormKeyTypes)
      .then(picked => { if (picked) onCommit?.(picked); });
  }

  // A FormKey reads the same editable or not — a link, not a form control. Editability shows in
  // the gesture: a second click on the focused cell opens the picker; on an immutable column plain
  // click is a no-op.
  function onPlainClick() {
    if (editable && isFocused) openPicker();
  }

  function renderValue() {
    // The placeholder keeps DiskCell's own cursor. `data-open-trigger`/onDoubleClick only apply
    // when mutable — scoping them to `editable` keeps the "which trigger reaches the editor"
    // story in one place.
    if (fk === null) {
      return (
        <span
          onClick={onPlainClick}
          onDoubleClick={editable ? openPicker : undefined}
          data-open-trigger={editable || undefined}
          style={{ opacity: 0.35 }}
        >—</span>
      );
    }
    return (
      <FormKeyLink
        value={fk}
        onOpen={onOpen}
        onPlainClick={onPlainClick}
        onDoubleClick={editable ? openPicker : undefined}
        openTrigger={editable}
        resolution={resolution}
      />
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {renderValue()}
      <CheckErrorIcon checkError={checkError} />
    </span>
  );
}
