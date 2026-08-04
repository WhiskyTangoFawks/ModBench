import React, { useState } from 'react';
import { modelValue } from './modelValue';
import { mono, fg } from './gridStyles';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // Issue #111: whether this cell's column is editable (its plugin is mutable). There is no
  // edit mode — editability is a property of the column, not of a state the user toggles.
  editable: boolean;
  // Issue #223 / ADR-0034: whether this is the panel's single focused cell (DiffRow/DiskCell's
  // `focusedCell`) — gates the mutable branch's plain click (second click on an already-focused
  // cell opens; a first click on an unfocused cell only focuses, via DiskCell's onFocusCell,
  // which fires *after* this click handler in the bubble order, so a first click never opens
  // here). Unused by the immutable branch below — see the note there. Optional, defaulting to
  // `true` (open-on-any-click, the pre-#223 behavior): ConditionSection renders this cell
  // directly, outside the field grid's focus model, and doesn't pass it — #223 is explicitly
  // scoped to the field grid only (ConditionSection/VmadSection adopt this model in #229/#231),
  // so a caller that has no focus concept must keep opening unconditionally, not go silently inert.
  isFocused?: boolean;
  onCommit: (v: unknown) => void;
}

// The text a cell shows when it is not being edited. Null/missing renders as an empty-looking
// em-dash, never "null"/"undefined" (spec: field type rendering rule 5). Issue #224: sources the
// non-null text from modelValue rather than its own toStr call, so this is provably the same
// string Ctrl+C copies (AC6) — not a second formatter that merely happens to agree with it today.
function ScalarText({ value, meta }: { value: unknown; meta: FieldMetadata }) {
  return value == null
    ? <span style={{ opacity: 0.35 }}>—</span>
    : <span>{modelValue(value, meta)}</span>;
}

export function ScalarCell({ value, meta, editable, isFocused = true, onCommit }: ScalarCellProps) {
  const [draft, setDraft] = useState(() => modelValue(value, meta));
  const [prevValue, setPrevValue] = useState(value);
  // Issue #111: only the clicked cell is an input; everything else stays text. Meaningless on an
  // immutable column post-#226 — the branch below returns before this ever flips true there — so
  // this state only ever describes the mutable editor now.
  const [active, setActive] = useState(false);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(modelValue(value, meta));
  }

  // Issue #226 / ADR-0034: an immutable column simply refuses. No editor opens and no distinct
  // affordance says so beforehand — matching xEdit's `vstViewEditing`, which sets
  // `Allowed := False` and shows nothing in advance. Checked ahead of `active`/`isFocused` since
  // there is no state to gate: a plain click, a second click, F2 and a double click all land here
  // and do nothing (this is the only branch, so none of those four gestures needs its own check).
  // Copy is Ctrl+C on the focused, unopened cell (#224, DiskCell/DiffRow) — this component has no
  // clipboard code of its own to give up.
  if (!editable) return <ScalarText value={value} meta={meta} />;

  // Issue #201 / ADR-0033: the resting state is text, no cursor of its own, clickable.
  if (!active) {
    // Issue #223 / ADR-0034: mutable columns gate opening behind xEdit's three triggers — a
    // second click on the already-focused cell (isFocused is still the *pre-click* value on a
    // first click, since this handler fires before DiskCell's ancestor onFocusCell in the bubble
    // order, so a first click on an unfocused cell never opens), F2 (DiskCell's own
    // `querySelector('[data-open-trigger]')?.click()`), or an unconditional double click.
    // Issue #204 / ADR-0033: no cursor override here — the parent DiskCell's `grab` cursor is
    // this cell's resting affordance (it's a drag source the whole time); a text-caret would
    // falsely imply only editing is possible until the cell is actually clicked into edit.
    return (
      <span
        data-open-trigger
        onClick={() => { if (isFocused) setActive(true); }}
        onDoubleClick={() => setActive(true)}
        style={{ display: 'block', minHeight: '1em' }}
      >
        <ScalarText value={value} meta={meta} />
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
    if (modelValue(next, meta) !== modelValue(value, meta)) onCommit(next);
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
      // Issue #201: autoFocus alone leaves the caret at the end, so Ctrl+V into a cell showing
      // `100` appends rather than replaces. Selecting on focus makes paste replace, and gives
      // type-to-replace for free. (A no-op on type="number" per spec, which is why the paired
      // test uses a text input.)
      onFocus={e => e.currentTarget.select()}
      onBlur={() => { commitIfChanged(coerce()); setActive(false); }}
      onKeyDown={e => { if (e.key === 'Enter') { commitIfChanged(coerce()); (e.target as HTMLInputElement).blur(); } }}
      style={inputBase}
    />
  );
}
