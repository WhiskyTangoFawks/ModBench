import React, { useContext, useRef, useState } from 'react';
import { EditorMounted } from './cellEditor';
import { colourOf, degreesOf, displayValue, modelValue, pastedValue } from './modelValue';
import { pickEnumValue } from './nativeBridge';
import { mono, fg } from './gridStyles';
import type { EnumChoice } from '../../src/wire/messages';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Absent where the column cannot be written, and the cell reads as text.
  onCommit?: (v: unknown) => void;
  // Replaces the resting label alone — the value Ctrl+C copies is still the real
  // model value.
  displayOverride?: string;
}

function enumChoices(value: unknown, meta: FieldMetadata): EnumChoice[] {
  const named = meta.enumMembers.map(m => ({ value: m.value, label: displayValue(m.value, meta) }));
  const current = modelValue(value, meta);
  const choices = value == null || named.some(c => c.value === current)
    ? named
    : [...named, { value: current, label: displayValue(value, meta) }];
  return choices.sort((a, b) => a.label.localeCompare(b.label));
}

function ScalarText({ value, meta, displayOverride }: {
  value: unknown; meta: FieldMetadata; displayOverride?: string;
}) {
  if (displayOverride != null) return <span>{displayOverride}</span>;
  if (value == null) return <span style={{ opacity: 0.35 }}>—</span>;
  const reading = displayValue(value, meta);
  const colour = meta.type === 'color' ? colourOf(reading) : null;
  if (colour !== null) return <span><Swatch colour={colour} />{reading}</span>;
  const degrees = meta.isPlacedRotation ? degreesOf(reading) : null;
  return degrees === null ? <span>{reading}</span> : <span>{reading} <span>{degrees}</span></span>;
}

function Swatch({ colour }: { colour: string }) {
  return (
    <span
      data-testid="colour-swatch"
      style={{
        display: 'inline-block',
        width: '1em',
        height: '1em',
        marginRight: '0.5em',
        verticalAlign: 'text-bottom',
        border: '1px solid var(--vscode-contrastBorder, #888)',
        backgroundColor: colour,
      }}
    />
  );
}

/** A click focuses a cell (editor.md, The focused cell, story 1); no left click reaches the
 *  extended editor (xedit.md, divergence 6). */
export function ScalarCell({
  value, meta, onCommit, displayOverride,
}: ScalarCellProps) {
  const [draft, setDraft] = useState(() => modelValue(value, meta));
  const [prevValue, setPrevValue] = useState(value);
  const [active, setActive] = useState(false);
  const settled = useRef(true);
  const picking = useRef(false);
  const editorMounted = useContext(EditorMounted);
  const isEnum = meta.type === 'enum' && meta.enumMembers.length > 0;
  function open() { settled.current = false; setActive(true); }
  function pickEnum() {
    if (picking.current) return;
    picking.current = true;
    void pickEnumValue(enumChoices(value, meta), modelValue(value, meta))
      .then(picked => { if (picked !== null && picked !== modelValue(value, meta)) onCommit?.(picked); })
      .finally(() => { picking.current = false; });
  }
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(modelValue(value, meta));
  }

  // Checked ahead of `active` because there is no state to gate: every open trigger
  // lands here and does nothing — matching xEdit's `vstViewEditing`, which sets `Allowed := False`
  // and shows nothing in advance.
  if (!onCommit) {
    return <ScalarText value={value} meta={meta} displayOverride={displayOverride} />;
  }

  if (!active) {
    // `data-open-trigger` is F2's target: DiskCell dispatches a real `.click()` at it. No
    // cursor override (editor.md, Drag and drop, story 2): a text caret would falsely imply editing
    // is the only thing a click can start.
    return (
      <span
        data-open-trigger
        onClick={isEnum ? pickEnum : open}
        style={{ display: 'block', minHeight: '1em' }}
      >
        <ScalarText value={value} meta={meta} displayOverride={displayOverride} />
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

  // A checkbox writes as it toggles, so closing it has nothing left to write.
  const pending = meta.type === 'bool' ? value : pastedValue(draft, meta);

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
    ref: editorMounted,
    autoFocus: true,
    onKeyDown: onEditorKeyDown,
    onBlur: () => settle(true),
  };

  if (meta.type === 'bool') {
    return (
      <input
        {...editorProps}
        type="checkbox"
        className="vscode-checkbox"
        checked={draft === 'True'}
        onChange={e => { setDraft(modelValue(e.target.checked, meta)); commitIfChanged(e.target.checked); }}
      />
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
