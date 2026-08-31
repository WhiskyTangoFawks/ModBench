import React, { useState } from 'react';
import { FormKeyCell } from './FormKeyCell';
import { mono } from './gridStyles';
import type { FieldMetadata, FormKeyResolution } from './types';

const OBJ_RE = /^(.+?)\s*\[(-?\d+)\]\s*$/;

// VMAD's Object-kind property Type is literally the string "Object" in the binary VMAD format —
// unlike an ordinary FormKey field's `FormLink<T>` generic parameter, there is no Papyrus-declared
// expected class name recorded anywhere in it for the frontend to read (VmadData.cs /
// VmadPropertyValue.Type; the backend's own VmadConflictClassifier.BuildResolutions carries the
// identical admission for the ADR-0031 resolution signal: "there's no Papyrus-declared expected
// record type to compare against"). So there is nothing to filter the picker with — empty, not
// invented.
const OBJECT_META: FieldMetadata = { name: '', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };

export interface VmadObjectEditorProps {
  value: unknown;
  // The compact, non-editing display — VmadObjectCell's own leafContent output
  // (FormKey link + "[alias]" + optional type cue) — shown until this cell is clicked into its
  // editor. VmadObjectEditor is VMAD's one genuine exception to "the shared leaf cells own their
  // whole click-to-edit lifecycle themselves": the shared FormKeyCell has no concept of the alias
  // it's paired with here, so this component keeps its own read/edit toggle rather than reusing a
  // second, generic wrapper shared with a different leaf kind.
  read: React.ReactNode;
  // Optional, defaulting to non-editable — matches every other leaf's contract
  // (presence of somewhere to write is the editability signal). Absent when the column is
  // immutable or the row is otherwise read-only (meta.readOnly), same gate DiffRow's renderCell
  // already computes for every other composite leaf type.
  onCommit?: (v: { formKey: string; alias: number }) => void;
  onOpen: (fk: string) => void;
  resolution?: FormKeyResolution;
}

export function VmadObjectEditor({ value, read, onCommit, onOpen, resolution }: Readonly<VmadObjectEditorProps>) {
  const [active, setActive] = useState(false);

  const str = typeof value === 'string' ? value : '';
  const m = OBJ_RE.exec(str);
  const diskFk = m ? m[1].trim() : str;
  const diskAlias = m ? Number(m[2]) : -1;

  const [draftFk, setDraftFk] = useState(diskFk);
  const [alias, setAlias] = useState(diskAlias);
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) { setPrevValue(value); setDraftFk(diskFk); setAlias(diskAlias); }

  // Ctrl+click on the read view is left to `read`'s own content (VmadObjectCell's FormKeyLink,
  // wired to onOpen) — this only ever decides whether a *plain* click opens the editor, exactly
  // like every other leaf's own gate. Gated on `onCommit` being present — an immutable/read-only
  // row gets no editor at all, matching ADR-0034 ("an immutable cell simply refuses").
  if (!active || !onCommit) {
    return (
      <span onClick={e => { if (onCommit && !e.ctrlKey && !e.metaKey) setActive(true); }}>{read}</span>
    );
  }

  return (
    <span
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setActive(false); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <FormKeyCell
        value={draftFk}
        meta={OBJECT_META}
        editable
        onOpen={onOpen}
        onCommit={fk => { setDraftFk(fk); onCommit({ formKey: fk, alias }); }}
        resolution={resolution}
      />
      <input
        type="number"
        value={alias}
        onChange={e => setAlias(Number(e.target.value))}
        // Same no-op guard as the scalar leaves: an unchanged alias commits nothing.
        onBlur={() => { if (alias !== diskAlias) onCommit({ formKey: draftFk, alias }); }}
        aria-label="Alias"
        style={{ width: 50, fontFamily: mono, fontSize: '12px' }}
      />
    </span>
  );
}
