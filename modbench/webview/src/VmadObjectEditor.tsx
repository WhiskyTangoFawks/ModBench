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
// invented (issue #229).
const OBJECT_META: FieldMetadata = { name: '', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };

export interface VmadObjectEditorProps {
  value: unknown;
  // Issue #229: the compact, non-editing display — VmadSection's own leafContent output (FormKey
  // link + "[alias]" + optional type cue) — shown until this cell is clicked into its editor.
  // VmadObjectEditor is VMAD's one genuine exception to "the shared leaf cells own their whole
  // click-to-edit lifecycle themselves": the shared FormKeyCell has no concept of the alias it's
  // paired with here, so this component keeps its own read/edit toggle rather than reusing a
  // second, generic wrapper shared with a different leaf kind (the duplication this issue removes).
  read: React.ReactNode;
  onCommit: (v: { formKey: string; alias: number }) => void;
  onOpen: (fk: string) => void;
  resolution?: FormKeyResolution;
}

export function VmadObjectEditor({ value, read, onCommit, onOpen, resolution }: Readonly<VmadObjectEditorProps>) {
  const [active, setActive] = useState(false);

  const str = typeof value === 'string' ? value : '';
  const m = OBJ_RE.exec(str);
  const diskFk = m ? m[1].trim() : str;
  const diskAlias = m ? Number(m[2]) : -1;

  const [pendingFk, setPendingFk] = useState(diskFk);
  const [alias, setAlias] = useState(diskAlias);
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) { setPrevValue(value); setPendingFk(diskFk); setAlias(diskAlias); }

  // Issue #229: Ctrl+click on the read view is left to `read`'s own content (VmadSection's
  // leafContent renders a FormKeyLink there, wired to onOpen) — this only ever decides whether a
  // *plain* click opens the editor, exactly like the deleted ClickToEdit did.
  if (!active) {
    return (
      <span onClick={e => { if (!e.ctrlKey && !e.metaKey) setActive(true); }}>{read}</span>
    );
  }

  return (
    <span
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setActive(false); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <FormKeyCell
        value={pendingFk}
        meta={OBJECT_META}
        editable
        onOpen={onOpen}
        onCommit={fk => { setPendingFk(fk); onCommit({ formKey: fk, alias }); }}
        resolution={resolution}
      />
      <input
        type="number"
        value={alias}
        onChange={e => setAlias(Number(e.target.value))}
        // Issue #229: same no-op guard as the scalar leaves — alias is the one value VMAD still
        // hand-rolls after this refactor, so it gets the identical fix rather than being left as
        // the one leaf that still stages a no-op edit.
        onBlur={() => { if (alias !== diskAlias) onCommit({ formKey: pendingFk, alias }); }}
        aria-label="Alias"
        style={{ width: 50, fontFamily: mono, fontSize: '12px' }}
      />
    </span>
  );
}
