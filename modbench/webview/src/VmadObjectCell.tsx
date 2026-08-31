import React from 'react';
import { FormKeyLink } from './FormKeyLink';
import { VmadObjectEditor } from './VmadObjectEditor';
import type { FormKeyResolution } from './types';

const OBJ_RE = /^(.+?)\s*(\[-?\d+\])\s*$/;

// The `renderCell` dispatch target for `FieldMetadata.type === 'vmadObject'` — the unified-tree
// caller of VmadObjectEditor. Builds the compact read view (a FormKeyLink plus the trailing
// "[alias]") from the "FormKey [Alias]" string the property's raw value already is —
// VmadObjectEditor itself owns its own read/edit toggle (the one place in the grid that isn't the
// shared click-to-edit lifecycle every other leaf uses: a (FormKey, alias) pair the shared
// FormKeyCell alone can't represent).
export function VmadObjectCell({ value, editable, onCommit, onOpen, resolution }: Readonly<{
  value: unknown;
  // Optional, matching every other leaf's contract — presence of somewhere to write
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
