import React from 'react';
import { FormKeyLink } from './FormKeyLink';
import { VmadObjectEditor } from './VmadObjectEditor';
import type { FormKeyResolution } from './types';

const OBJ_RE = /^(.+?)\s*(\[-?\d+\])\s*$/;

// Issue #231: the `renderCell` dispatch target for `FieldMetadata.type === 'vmadObject'` — the
// unified-tree caller of #229's VmadObjectEditor (#426 Track 5: restored), now that a VMAD object
// property is an ordinary row rather than a bespoke one. Builds the same compact read view
// VmadSection's own leafContent used to (a FormKeyLink plus the trailing "[alias]"), from the same
// "FormKey [Alias]" string the property's raw value already is — VmadObjectEditor itself still
// owns its own read/edit toggle (the one place in the grid that isn't the shared click-to-edit
// lifecycle every other leaf uses, per #229's own doc comment: a (FormKey, alias) pair the shared
// FormKeyCell alone can't represent).
export function VmadObjectCell({ value, editable, onCommit, onOpen, resolution }: Readonly<{
  value: unknown;
  // #426 Track 5: optional, matching every other leaf's contract — presence of somewhere to write
  // is the editability signal. `editable` mirrors DiffRow's own per-cell computation (ORed with
  // the per-row readOnly veto); `onCommit` is only ever actually invoked when both this and the
  // ambient column mutability agree, via the `onCommit && editable` gate below.
  editable?: boolean;
  onCommit?: (v: unknown) => void;
  onOpen: (fk: string) => void;
  resolution?: FormKeyResolution;
}>) {
  const str = typeof value === 'string' ? value : '';
  const m = OBJ_RE.exec(str);
  const fk = m ? m[1] : str;

  const read = fk
    ? (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <FormKeyLink value={fk} onOpen={onOpen} resolution={resolution} />
        {m && <span>&nbsp;{m[2]}</span>}
      </span>
    )
    : <span style={{ opacity: 0.35 }}>—</span>;

  return (
    <VmadObjectEditor
      value={value}
      read={read}
      onCommit={editable && onCommit ? (v => onCommit(v)) : undefined}
      onOpen={onOpen}
      resolution={resolution}
    />
  );
}
