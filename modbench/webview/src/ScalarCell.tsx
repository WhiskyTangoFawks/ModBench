import React, { useState } from 'react';
import { toStr } from './recordUtils';
import { mono, fg } from './gridStyles';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Issue #111: whether this cell's column is editable (its plugin is mutable). There is no
  // edit mode — editability is a property of the column, not of a state the user toggles.
  editable: boolean;
  onCommit: (v: unknown) => void;
}

// The text a cell shows when it is not being edited. Null/missing renders as an empty-looking
// em-dash, never "null"/"undefined" (spec: field type rendering rule 5).
function ScalarText({ value }: { value: unknown }) {
  return value == null
    ? <span style={{ opacity: 0.35 }}>—</span>
    : <span>{toStr(value)}</span>;
}

export function ScalarCell({ value, meta, editable, onCommit }: ScalarCellProps) {
  const [draft, setDraft] = useState(() => toStr(value));
  const [prevValue, setPrevValue] = useState(value);
  // Issue #111: only the clicked cell is an input; everything else stays text.
  const [active, setActive] = useState(false);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(toStr(value));
  }

  if (!editable) return <ScalarText value={value} />;

  if (!active) {
    // Issue #204 / ADR-0033: no cursor override here — the parent DiskCell's `grab` cursor is
    // this cell's resting affordance (it's a drag source the whole time); a text-caret would
    // falsely imply only editing is possible until the cell is actually clicked into edit.
    return (
      <span onClick={() => setActive(true)} style={{ display: 'block', minHeight: '1em' }}>
        <ScalarText value={value} />
      </span>
    );
  }

  const inputBase: React.CSSProperties = {
    fontFamily: mono,
    fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)',
    color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '1px 4px',
    width: '100%',
    boxSizing: 'border-box',
  };

  // Issue #111: click-to-activate puts every cell one mis-click away from staging, so no path
  // commits a value equal to the one already there. A change whose old value equals its new
  // value is not an edit: it is noise in the Pending Changes tree that drags a whole
  // ChangeGroup's dependency closure with it (ADR-0028). Comparing the rendered strings keeps
  // this in the same terms the draft is held in, so 5 typed over 5 is a no-op like any other.
  function commitIfChanged(next: unknown) {
    if (toStr(next) !== toStr(value)) onCommit(next);
  }

  if (meta.type === 'bool') {
    return (
      <input
        type="checkbox"
        autoFocus
        checked={draft === 'true'}
        onChange={e => { setDraft(String(e.target.checked)); commitIfChanged(e.target.checked); }}
        onBlur={() => setActive(false)}
      />
    );
  }

  if (meta.type === 'enum' && meta.enumValues.length > 0) {
    return (
      <select
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { commitIfChanged(draft); setActive(false); }}
        style={inputBase}
      >
        {meta.enumValues.map(ev => <option key={ev}>{ev}</option>)}
      </select>
    );
  }

  function coerce(): unknown {
    if (meta.type === 'int') { const n = parseInt(draft, 10); return isNaN(n) ? value : n; }
    if (meta.type === 'float') { const n = parseFloat(draft); return isNaN(n) ? value : n; }
    return draft;
  }

  return (
    <input
      autoFocus
      type={meta.type === 'int' || meta.type === 'float' ? 'number' : 'text'}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { commitIfChanged(coerce()); setActive(false); }}
      onKeyDown={e => { if (e.key === 'Enter') { commitIfChanged(coerce()); (e.target as HTMLInputElement).blur(); } }}
      style={inputBase}
    />
  );
}
