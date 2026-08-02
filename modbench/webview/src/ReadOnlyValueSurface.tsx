import React from 'react';
import { mono, fg } from './gridStyles';

// Issue #201 / ADR-0033: visibly inert — it reads as "you may select this", not "you may edit
// this", so it carries none of the editor's border or background. No `cursor` declaration either:
// a focused input paints its own caret, and asserting one would be the #204 mask in the one state
// where it happens to be true.
//
// minWidth: 0 is load-bearing, not tidying — FormKeyCell wraps this in a `display: inline-flex`
// span, and a flex item's default `min-width: auto` refuses to shrink below its content, so
// `width: 100%` would blow the column out instead of fitting it. Same trap #218 hit.
const inertInput: React.CSSProperties = {
  fontFamily: mono,
  fontSize: '12px',
  color: fg,
  background: 'none',
  border: 'none',
  outline: 'none',
  padding: 0,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
};

// Issue #201 / ADR-0033 (cursor contract): the activated state of a cell in an immutable column.
// A real <input readOnly>, not a styled span, for two reasons that both matter: a draggable
// ancestor swallows text selection, and DiskCell already drops `draggable` when an INPUT in its
// subtree takes focus — so a real input trips that existing mechanism and the cursor flips from
// `grab` to a caret with no new wiring. Commits nothing; that is the only difference between this
// surface and the editor a mutable column activates.
export function ReadOnlyValueSurface({ value, onBlur }: Readonly<{
  value: string;
  onBlur: () => void;
}>) {
  return (
    <input
      readOnly
      autoFocus
      value={value}
      // Issue #201: hand over the whole value pre-selected — Ctrl+C is then immediate, the
      // highlight is what signals the text is selectable, and a value too wide for its column
      // still copies in full even though only part of it is visible.
      onFocus={e => e.currentTarget.select()}
      onBlur={onBlur}
      style={inertInput}
    />
  );
}
