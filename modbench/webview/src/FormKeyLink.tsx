import React from 'react';
import { mono } from './gridStyles';
import type { FormKeyResolution } from './types';

// Safe default when a caller has no resolution to offer —
// behaves exactly like a genuinely unresolved reference: raw FormKey label.
const UNRESOLVED: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

// "EditorID [FormKey]" when the record is named, the bare FormKey when it isn't. Exported so
// the Ctrl+C copy path produces exactly what the link displays — a cell must never show one
// string and hand over another.
export function formKeyLabel(value: string, resolution?: Pick<FormKeyResolution, 'editorId'>): string {
  return resolution?.editorId ? `${resolution.editorId} [${value}]` : value;
}

// The label is the composite, never the bare EditorID: a FormKey is the identity and the EditorID
// is decoration, and it is the format the picker's own items use, so a reference reads back as it
// was chosen.
export function FormKeyLink({ value, onClick, openTrigger, resolution = UNRESOLVED }: Readonly<{
  value: string;
  onClick?: () => void;
  openTrigger?: boolean;
  resolution?: FormKeyResolution;
}>) {
  const label = formKeyLabel(value, resolution);

  return (
    <button
      data-open-trigger={openTrigger || undefined}
      onClick={e => { if (!e.ctrlKey && !e.metaKey) onClick?.(); }}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--vscode-textLink-foreground, #3794ff)',
        fontFamily: mono,
        fontSize: '12px',
        padding: 0,
        textDecoration: 'none',
        textAlign: 'left',
        // gridStyles' baseCell already ellipsises the <td>, but text-overflow clips at the
        // boundary of an atomic inline box and never reaches inside a <button>'s own text, so
        // relying on the cell alone would hard-clip mid-character.

        // `minWidth: 0` is load-bearing: this button is a flex item, and a flex item's default
        // `min-width: auto` refuses to shrink below its content, defeating the ellipsis above.
        display: 'inline-block',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        verticalAlign: 'bottom',
      }}
    >
      {label}
    </button>
  );
}
