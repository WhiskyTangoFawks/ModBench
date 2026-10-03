import React, { useRef, useState } from 'react';
import { displayValue, modelValue, pastedValue } from './modelValue';
import { mono, fg } from './gridStyles';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // There is no edit mode — editability is a property of the column (is the plugin mutable, is it
  // tracked), never of a state the user toggles into.
  editable?: boolean;
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

/** ADR-0018; xedit.md, divergence 6. */
export function ScalarCell({
  value, meta, editable = false, onCommit, ariaLabel, displayOverride,
}: ScalarCellProps) {
  const [draft, setDraft] = useState(() => modelValue(value, meta));
  const [prevValue, setPrevValue] = useState(value);
  const [active, setActive] = useState(false);
  const settled = useRef(true);
  function open() { settled.current = false; setActive(true); }
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(modelValue(value, meta));
  }

  // Checked ahead of `active` because there is no state to gate: every open trigger
  // lands here and does nothing — matching xEdit's `vstViewEditing`, which sets `Allowed := False`
  // and shows nothing in advance.
  if (!editable || !onCommit) {
    return <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />;
  }

  if (!active) {
    // `data-open-trigger` is F2's target: DiskCell dispatches a real `.click()` at it. No
    // cursor override (editor.md, Drag and drop, story 4): a text caret would falsely imply editing
    // is the only thing a click can start.
    return (
      <span
        data-open-trigger
        onClick={open}
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
    userSelect: 'text',
  };

  // A commit writes a file, so every mis-click is a working-tree change. A value equal to the one
  // already there is not an edit — committing it would show the record dirty for a keystroke
  // nobody made.
  const commit = onCommit;
  function commitIfChanged(next: unknown) {
    if (modelValue(next, meta) !== modelValue(value, meta)) commit(next);
  }

  const isEnum = meta.type === 'enum' && meta.enumMembers.length > 0;
  // A checkbox writes as it toggles, so closing it has nothing left to write.
  const pending = meta.type === 'bool' ? value : isEnum ? draft : pastedValue(draft, meta, value);

  // Enter, Esc and a blur each end the editor, and the focus Enter and Esc hand back blurs it again.
  function settle(write: boolean) {
    if (settled.current) return;
    settled.current = true;
    if (write) commitIfChanged(pending);
    else setDraft(modelValue(value, meta));
    setActive(false);
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    const cell = e.currentTarget.closest('td');
    settle(e.key === 'Enter');
    cell?.focus();
  }

  const editorProps = {
    'data-editor': true,
    'aria-label': ariaLabel,
    autoFocus: true,
    onKeyDown: onEditorKeyDown,
    onBlur: () => settle(true),
  };

  if (meta.type === 'bool') {
    return (
      <input
        {...editorProps}
        type="checkbox"
        checked={draft === 'True'}
        onChange={e => { setDraft(modelValue(e.target.checked, meta)); commitIfChanged(e.target.checked); }}
      />
    );
  }

  if (isEnum) {
    return (
      <select {...editorProps} value={draft} onChange={e => setDraft(e.target.value)} style={inputBase}>
        {meta.enumMembers.map(m =>
          <option key={m.value} value={m.value}>{displayValue(m.value, meta)}</option>)}
      </select>
    );
  }

  return (
    <input
      {...editorProps}
      type={meta.type === 'int' || meta.type === 'float' ? 'number' : 'text'}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      // autoFocus alone leaves the caret at the end, so Ctrl+V into a cell showing
      // `100` appends rather than replaces. Selecting on focus makes paste replace, and gives
      // type-to-replace for free.
      onFocus={e => e.currentTarget.select()}
      style={inputBase}
    />
  );
}
