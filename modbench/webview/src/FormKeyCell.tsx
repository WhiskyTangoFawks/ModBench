import React from 'react';
import { pickFormKey } from './nativeBridge';
import { FormKeyLink, formKeyLabel } from './FormKeyLink';
import { CheckErrorIcon } from './CheckErrorIcon';
import type { FieldMetadata, FormKeyResolution } from './types';

interface FormKeyCellProps {
  value: unknown;
  meta: FieldMetadata;
  editable: boolean;
  // Issue #223 / ADR-0034: see ScalarCell's identical prop for the full rationale — gates the
  // mutable branch's plain-click open of the QuickPick. Unused by the immutable branch: post-#226
  // that branch opens nothing regardless of focus. Optional, defaulting to `true`:
  // ConditionSection renders this cell directly (its Object-typed parameter/Run-On/comparison
  // FormKey cells), outside the field grid's focus model, and doesn't pass it — same reasoning
  // as ScalarCell's identical default.
  isFocused?: boolean;
  onOpen: (fk: string) => void;
  onCommit: (fk: string) => void;
  checkError?: string | null;
  // ADR-0031 / issue #157: the leaf's own resolution signal, gating the link affordance and
  // label — independent of checkError, which still drives the ⚠ icon below but no longer the
  // link (a resolved-but-wrong-type reference carries a checkError yet is still followable).
  resolution?: FormKeyResolution;
}

export function FormKeyCell({ value, meta, editable, isFocused = true, onOpen, onCommit, checkError, resolution }: FormKeyCellProps) {
  const fk = typeof value === 'string' && value ? value : null;

  // Issue #223: the picker call itself, split out so both the gated plain-click path and the
  // unconditional double-click path share it.
  function openPicker() {
    // Issue #218: seeded with the composite this cell displays, not the bare FormKey — the
    // picker's native input is where a mutable cell's value is selected and copied, so seeding it
    // with something the cell never showed would leave the one column kind that can edit a
    // reference unable to hand it over. The picker normalizes a composite back to its reference
    // before searching, so this costs the search nothing.
    void pickFormKey(fk ? formKeyLabel(fk, resolution) : '', meta.validFormKeyTypes)
      .then(picked => { if (picked) onCommit(picked); });
  }

  // Issue #111: the cell reads the same whether or not its column is editable — a FormKey is a
  // link, not a form control. Editability shows up in the gesture, not the paint: plain click
  // opens the picker only where the column is mutable, and Ctrl+click follows the reference
  // everywhere (including immutable columns).
  // Issue #210: the picker itself is a native QuickPick (only the extension host can call
  // vscode.window.createQuickPick), seeded with the current reference — pickFormKey resolves to
  // the picked FormKey, or null on Escape/blur, in which case the field is left unchanged.
  // Issue #223 / ADR-0034: the mutable branch gates on isFocused — a second click on the
  // already-focused cell opens the picker; a first click on an unfocused cell only focuses (via
  // DiskCell's onFocusCell, which fires after this handler in the bubble order).
  // Issue #226 / ADR-0034: on an immutable column this is a no-op — there is no read-only surface
  // left to activate, so plain click does nothing there, matching every other leaf's refusal.
  // Ctrl+click is unaffected either way: FormKeyLink routes that to onOpen and never calls
  // onPlainClick, so following a reference is unreachable from here regardless of editability.
  function onPlainClick() {
    if (editable && isFocused) openPicker();
  }

  function renderValue() {
    // Issue #201 / #204: no cursor override on the placeholder — the parent DiskCell's `grab` is
    // the resting affordance here as everywhere else in the grid.
    // Issue #223: `data-open-trigger`/onDoubleClick only apply when mutable — an immutable empty
    // cell already does nothing via onPlainClick (fk is null there too), so adding them
    // unconditionally would be harmless, but scoping them to `editable` keeps the "which trigger
    // reaches the editor" story in one place (the same `editable` gate every other leaf uses).
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
    // Issue #226: no more `active` branch — an immutable column's link renders unconditionally,
    // and onPlainClick (above) is a no-op there, so plain click opens nothing.
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
