import React from 'react';
import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const OBJ_RE = /^(.+?)\s*(\[-?\d+\])\s*$/;

// Issue #231: the `renderCell` dispatch target for `FieldMetadata.type === 'vmadObject'` — the
// compact read view for a VMAD object property (a FormKeyLink plus the trailing "[alias]"), built
// from the same "FormKey [Alias]" string the property's raw value already is.
//
// #410/ADR-0041: read-only. #229's VmadObjectEditor — the (FormKey, alias) pair editor this cell
// wrapped — retired with the write path behind it; the link still follows, which is a read.
export function VmadObjectCell({ value, onOpen, resolution }: Readonly<{
  value: unknown;
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

  return read;
}
