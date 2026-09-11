import React, { useState } from 'react';
import { displayValue, modelValue } from './modelValue';
import { mono, fg } from './gridStyles';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // There is no edit mode — editability is a property of the column (is the plugin mutable, is it
  // tracked), never of a state the user toggles into.
  editable?: boolean;
  // ADR-0018: gates the plain click, so a *second* click on an already-focused cell opens while a
  // first click only focuses — this handler runs before DiskCell's ancestor onFocusCell, so
  // `isFocused` is still the pre-click value here.
  isFocused?: boolean;
  // Where an edited value goes. Absent is the ordinary state for every caller outside the
  // field grid — there is nowhere to write, so the cell
  // renders as text, which is what those callers already had.
  onCommit?: (v: unknown) => void;
  // An accessible name for the resting cell, so tests (and screen readers) can
  // address one cell among many identical-looking ones.
  ariaLabel?: string;
  // Replaces the resting label alone — the value Ctrl+C copies is still the real
  // model value.
  displayOverride?: string;
}

function ScalarText({ value, meta, displayOverride, ariaLabel }: {
  value: unknown; meta: FieldMetadata; displayOverride?: string; ariaLabel?: string;
}) {
  if (displayOverride != null) return <span aria-label={ariaLabel}>{displayOverride}</span>;
  return value == null
    ? <span aria-label={ariaLabel} style={{ opacity: 0.35 }}>—</span>
    : <span aria-label={ariaLabel}>{displayValue(value, meta)}</span>;
}

/** ADR-0018: xEdit's gesture, unchanged — a click *focuses* a cell, it does not edit it.
 *  ADR-0018: a VS Code tab relocates the user, so no left-click gesture may reach the extended
 *  editor. */
export function ScalarCell({
  value, meta, editable = false, isFocused = true, onCommit, ariaLabel, displayOverride,
}: ScalarCellProps) {
  const [draft, setDraft] = useState(() => modelValue(value, meta));
  const [prevValue, setPrevValue] = useState(value);
  const [active, setActive] = useState(false);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(modelValue(value, meta));
  }

  // Checked ahead of `active`/`isFocused` because there is no state to gate: every open trigger
  // lands here and does nothing — matching xEdit's `vstViewEditing`, which sets `Allowed := False`
  // and shows nothing in advance.
  if (!editable || !onCommit) {
    return <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />;
  }

  if (!active) {
    // `data-open-trigger` is F2's target: DiskCell dispatches a real `.click()` at it. ADR-0018:
    // no cursor override — a text caret would falsely imply editing is the only thing a click can
    // start.
    return (
      <span
        data-open-trigger
        onClick={() => { if (isFocused) setActive(true); }}
        onDoubleClick={() => setActive(true)}
        style={{ display: 'block', minHeight: '1em' }}
      >
        <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />
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

  // A commit writes a file, so every mis-click is a working-tree change. A value equal to the one
  // already there is not an edit — committing it would show the record dirty for a keystroke
  // nobody made.
  const commit = onCommit;
  function commitIfChanged(next: unknown) {
    if (modelValue(next, meta) !== modelValue(value, meta)) commit(next);
  }

  if (meta.type === 'bool') {
    return (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        autoFocus
        checked={draft === 'true'}
        onChange={e => { setDraft(String(e.target.checked)); commitIfChanged(e.target.checked); }}
        onBlur={() => setActive(false)}
      />
    );
  }

  if (meta.type === 'enum' && meta.enumMembers.length > 0) {
    return (
      <select
        aria-label={ariaLabel}
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { commitIfChanged(draft); setActive(false); }}
        style={inputBase}
      >
        {meta.enumMembers.map(m =>
          <option key={m.value} value={m.value}>{displayValue(m.value, meta)}</option>)}
      </select>
    );
  }

  function coerce(): unknown {
    if (meta.type === 'int') { const n = parseInt(draft, 10); return isNaN(n) ? value : n; }
    if (meta.type === 'float') { const n = parseFloat(draft); return isNaN(n) ? value : n; }
    // The codec's own spelling of a translated string, with only its text changed.
    if (meta.type === 'translatedString') return { ...(typeof value === 'object' ? value : null), Value: draft };
    return draft;
  }

  return (
    <input
      aria-label={ariaLabel}
      autoFocus
      type={meta.type === 'int' || meta.type === 'float' ? 'number' : 'text'}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      // autoFocus alone leaves the caret at the end, so Ctrl+V into a cell showing
      // `100` appends rather than replaces. Selecting on focus makes paste replace, and gives
      // type-to-replace for free.
      onFocus={e => e.currentTarget.select()}
      onBlur={() => { commitIfChanged(coerce()); setActive(false); }}
      // Enter only leaves the cell; the blur above is the one commit path.
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      style={inputBase}
    />
  );
}
