import React, { useState } from 'react';
import { toStr } from './recordUtils';
import { mono, fg } from './gridStyles';
import { ReadOnlyValueSurface } from './ReadOnlyValueSurface';
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
// em-dash, never "null"/"undefined" (spec: field type rendering rule 5).
function ScalarText({ value }: { value: unknown }) {
  return value == null
    ? <span style={{ opacity: 0.35 }}>—</span>
    : <span>{toStr(value)}</span>;
}

export function ScalarCell({ value, meta, editable, isFocused = true, onCommit }: ScalarCellProps) {
  const [draft, setDraft] = useState(() => toStr(value));
  const [prevValue, setPrevValue] = useState(value);
  // Issue #111: only the clicked cell is an input; everything else stays text.
  const [active, setActive] = useState(false);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(toStr(value));
  }

  // Issue #201 / ADR-0033: the resting state is the same in both column kinds — text, no cursor
  // of its own, clickable. Editability shows up only in *what* the click activates, below.
  if (!active) {
    if (!editable) {
      // Issue #201 / ADR-0033: on an immutable column `—` is a placeholder, not a value — the
      // same argument the ADR makes for `{…}` and `[3]`. A surface here would offer an empty
      // selection that looks like a successful copy.
      if (value == null) return <ScalarText value={value} />;
      // Issue #223: deliberately untouched by this ticket's open-gate — plain click keeps
      // activating the read-only surface unconditionally, exactly as it did before #223. #226
      // ("Retire the read-only value surface") is what gates/removes this, and only once #224
      // (Ctrl+C copies the focused cell's model value) ships its replacement copy path — gating
      // it here first would make an immutable cell's value briefly uncopyable. No
      // `data-open-trigger` here either, so F2 correctly does nothing on this branch (it never
      // did before this ticket).
      return (
        <span onClick={() => setActive(true)} style={{ display: 'block', minHeight: '1em' }}>
          <ScalarText value={value} />
        </span>
      );
    }
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
        <ScalarText value={value} />
      </span>
    );
  }

  // Issue #201: an immutable column activates a read-only surface instead of an editor, before
  // any type branching below — so string/int/float/bool/enum are all covered by this one line
  // and nothing here is type-aware.
  if (!editable) return <ReadOnlyValueSurface value={toStr(value)} onBlur={() => setActive(false)} />;

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
