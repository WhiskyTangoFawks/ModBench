import React, { useEffect, useRef, useState } from 'react';
import { modelValue } from './modelValue';
import { mono, fg } from './gridStyles';
import type { FieldMetadata } from './types';

// Issue #230: how long a second click on an already-focused string cell waits before opening the
// inline editor, giving a following native `dblclick` event time to arrive and redirect it to the
// extended editor instead. A standard debounce window (VS Code's own Explorer uses the same shape
// for single-click-preview vs double-click-permanent-tab) — not tuned to any particular OS
// double-click-speed setting, since the browser's own `dblclick` event (not a second `click`) is
// what actually cancels this timer.
const STRING_OPEN_DEBOUNCE_MS = 300;

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
  // Issue #230 / ADR-0034 (#426: restored): only meaningful for `meta.type === 'string'` — every
  // other type's double click already opens the same (inline) editor second-click/F2 does, so
  // there's nothing for this to redirect. Called instead of the inline editor on a genuine double
  // click, mutable or immutable alike (a read-only tab is still the only way to read a long value
  // in full). Optional and left undefined by callers outside the field grid (VMAD, Condition
  // sections — Track 5), where a string cell's double click keeps opening the inline editor.
  onOpenExtended?: () => void;
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
 * #426 restores the one divergence #415 deliberately left out: a `string` cell's double click
 * opens the extended editor (`onOpenExtended`) instead of the inline one — see the debounce logic
 * in the `!active` branch below for how a genuine double click is told apart from the second click
 * of the same two-click sequence.
 *
 * An immutable or untracked column simply refuses: no editor, and no distinct affordance
 * beforehand — matching xEdit's own `vstViewEditing`, which sets `Allowed := False` and shows
 * nothing in advance. The signposting for *why*, and the way out, lives on the column header
 * (PluginHeader), where it can be read without first attempting an edit. The one exception is the
 * same `string`/`onOpenExtended` pair: a double click still reaches the extended editor, read-only
 * (AC5's "read-only over absent" — a locked tab is still the only way to read a long value in full).
 */
export function ScalarCell({
  value, meta, editable = false, isFocused = true, onCommit, ariaLabel, displayOverride, onOpenExtended,
}: ScalarCellProps) {
  const [draft, setDraft] = useState(() => modelValue(value, meta));
  const [prevValue, setPrevValue] = useState(value);
  const [active, setActive] = useState(false);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(modelValue(value, meta));
  }

  // Issue #230: the pending "open the inline editor" timer a string cell's second click starts —
  // cleared by a following genuine `dblclick` (redirects to onOpenExtended instead) and on
  // unmount, so a cell that scrolls out of the grid mid-debounce never fires a state update after
  // it's gone.
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (openTimerRef.current) clearTimeout(openTimerRef.current); }, []);
  function clearOpenTimer() {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
  }

  // Checked ahead of `active`/`isFocused` because there is no state to gate: a plain click, a
  // second click, F2 and a double click all land here and do nothing. Ctrl+C on the focused,
  // unopened cell still works (#224, DiskCell/DiffRow) — reading out of a read-only column is
  // still a read.
  //
  // Issue #230: the one exception — a `string` cell whose caller wired `onOpenExtended` gets a
  // double click that opens the extended editor read-only, so an immutable column's long value
  // still has somewhere to be read in full. No `data-open-trigger` here: F2 and a second click
  // stay exactly as inert as every other immutable cell — only double click is being carved out.
  if (!editable || !onCommit) {
    if (meta.type === 'string' && onOpenExtended) {
      return <span onDoubleClick={onOpenExtended}><ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} /></span>;
    }
    return <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />;
  }

  if (!active) {
    // `data-open-trigger` is F2's target: DiskCell dispatches a real `.click()` at it, so all three
    // xEdit triggers converge on one code path instead of three near-copies.
    // Issue #204 / ADR-0033: no cursor override — the parent DiskCell's own cursor is the resting
    // affordance; a text caret would falsely imply editing is the only thing a click can start.
    //
    // Issue #230: `string` is the one type whose double-click target (the extended editor) differs
    // from second-click/F2's (the inline editor) — see the gesture matrix, spec. The second
    // click's own "open inline" action is debounced by STRING_OPEN_DEBOUNCE_MS so a genuine
    // following `dblclick` can cancel it and open the extended editor instead. The debounce only
    // applies to a *real* click: F2's own dispatch is a real `.click()` call, which the DOM spec
    // gives `detail: 0` (a real user click always carries `detail >= 1`), so that path is excluded
    // and F2 keeps opening the inline editor immediately, matching "F2 always means inline, for
    // every type". Every other type is unaffected: its second click and double click already
    // agree, so neither needs a timer.
    if (meta.type === 'string') {
      return (
        <span
          data-open-trigger
          onClick={e => {
            if (!isFocused) return;
            if (e.detail === 0) { setActive(true); return; }
            clearOpenTimer();
            openTimerRef.current = setTimeout(() => {
              openTimerRef.current = null;
              setActive(true);
            }, STRING_OPEN_DEBOUNCE_MS);
          }}
          onDoubleClick={() => {
            clearOpenTimer();
            if (onOpenExtended) onOpenExtended(); else setActive(true);
          }}
          style={{ display: 'block', minHeight: '1em' }}
        >
          <ScalarText value={value} meta={meta} displayOverride={displayOverride} ariaLabel={ariaLabel} />
        </span>
      );
    }
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
