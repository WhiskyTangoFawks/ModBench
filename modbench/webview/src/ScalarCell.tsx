import React, { useState } from 'react';
import { modelValue } from './modelValue';
import { mono, fg } from './gridStyles';
import type { FieldMetadata } from './types';

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  // #415: whether this cell's column can be written. There is no edit mode — editability is a
  // property of the column (is the plugin mutable, is its mod tracked), never of a state the user
  // toggles into (issue #111's original rule, unchanged by the move to text).
  editable?: boolean;
  // Issue #223 / ADR-0034: whether this is the panel's single focused cell. Gates the plain click,
  // so a *second* click on an already-focused cell opens while a first click only focuses — this
  // handler runs before DiskCell's ancestor onFocusCell in the bubble order, so `isFocused` is
  // still the pre-click value here. Defaults true (open on any click) for callers outside the
  // field grid's focus model.
  isFocused?: boolean;
  // #415: where an edited value goes. Absent is the ordinary state for every caller outside the
  // field grid (the Condition section's cells, for one) — there is nowhere to write, so the cell
  // renders as text, which is what those callers already had.
  onCommit?: (v: unknown) => void;
  // Issue #205: an accessible name for the resting cell, so tests (and screen readers) can
  // address one cell among many identical-looking ones.
  ariaLabel?: string;
  // Issue #165: replaces the resting label alone — the value Ctrl+C copies is still the real
  // model value.
  displayOverride?: string;
}

function ScalarText({ value, meta, displayOverride, ariaLabel }: {
  value: unknown; meta: FieldMetadata; displayOverride?: string; ariaLabel?: string;
}) {
  if (displayOverride != null) return <span aria-label={ariaLabel}>{displayOverride}</span>;
  return value == null
    ? <span aria-label={ariaLabel} style={{ opacity: 0.35 }}>—</span>
    : <span aria-label={ariaLabel}>{modelValue(value, meta)}</span>;
}

/**
 * #415/ADR-0041: the record editor's one editing gesture, restored on the text-first write path.
 *
 * The gesture is xEdit's, unchanged and non-negotiable (ADR-0034, root CLAUDE.md): a click
 * *focuses* a cell, it does not edit it. Editing opens on a second click on the already-focused
 * cell, on F2, or on a double click. Specifying this from memory rather than from xEdit is what
 * cost #201/#204/#218, so it is restored exactly as it stood before #410 rather than re-derived.
 *
 * Deliberately *not* back yet: the extended-editor redirect for long strings (#230), and the
 * FormKey / flag / complex-field editors. Those are the split-out gesture-inventory ticket; this
 * ticket restores one gesture end to end so the vertical is real rather than notional. A `string`
 * cell therefore behaves like every other type here — second click and double click agree, so
 * there is nothing to debounce between them.
 *
 * An immutable or untracked column simply refuses: no editor, and no distinct affordance
 * beforehand — matching xEdit's own `vstViewEditing`, which sets `Allowed := False` and shows
 * nothing in advance. The signposting for *why*, and the way out, lives on the column header
 * (PluginHeader), where it can be read without first attempting an edit.
 */
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

  // Checked ahead of `active`/`isFocused` because there is no state to gate: a plain click, a
  // second click, F2 and a double click all land here and do nothing. Ctrl+C on the focused,
  // unopened cell still works (#224, DiskCell/DiffRow) — reading out of a read-only column is
  // still a read.
  if (!editable || !onCommit) {
    return <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />;
  }

  if (!active) {
    // `data-open-trigger` is F2's target: DiskCell dispatches a real `.click()` at it, so all three
    // xEdit triggers converge on one code path instead of three near-copies.
    // Issue #204 / ADR-0033: no cursor override — the parent DiskCell's own cursor is the resting
    // affordance; a text caret would falsely imply editing is the only thing a click can start.
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

  // Issue #111, and more so now that a commit writes a file: click-to-activate puts every cell one
  // mis-click away from a working-tree change. A value equal to the one already there is not an
  // edit — committing it would rewrite the ledger file, produce a diff of nothing, and show the
  // record as dirty in the Source Control panel for a keystroke the user never made. Compared as
  // rendered strings, so 5 typed over 5 is a no-op like any other.
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

  if (meta.type === 'enum' && meta.enumValues.length > 0) {
    return (
      <select
        aria-label={ariaLabel}
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
      aria-label={ariaLabel}
      autoFocus
      type={meta.type === 'int' || meta.type === 'float' ? 'number' : 'text'}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      // Issue #201: autoFocus alone leaves the caret at the end, so Ctrl+V into a cell showing
      // `100` appends rather than replaces. Selecting on focus makes paste replace, and gives
      // type-to-replace for free.
      onFocus={e => e.currentTarget.select()}
      onBlur={() => { commitIfChanged(coerce()); setActive(false); }}
      onKeyDown={e => { if (e.key === 'Enter') { commitIfChanged(coerce()); (e.target as HTMLInputElement).blur(); } }}
      style={inputBase}
    />
  );
}
