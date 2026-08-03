import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ScalarCell } from './ScalarCell';
import type { FieldMetadata } from './types';

// ── shared metadata fixtures ──────────────────────────────────────────────────

const strMeta: FieldMetadata  = { name: 'Name',   type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
const intMeta: FieldMetadata  = { name: 'Level',  type: 'int',    isArray: false, validFormKeyTypes: [], enumValues: [] };
const floatMeta: FieldMetadata = { name: 'Weight', type: 'float',  isArray: false, validFormKeyTypes: [], enumValues: [] };
const boolMeta: FieldMetadata = { name: 'Female', type: 'bool',   isArray: false, validFormKeyTypes: [], enumValues: [] };
const enumMeta: FieldMetadata = {
  name: 'Gender', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumValues: ['Male', 'Female', 'None'],
};

// Issue #201 / ADR-0033 (cursor contract): an immutable cell is no longer inert text. Clicking it
// activates a read-only text surface, and (until #224) that surface was the whole of copy —
// selection and Ctrl+C are the platform's once an input is focused. #224 added a second copy path
// (Ctrl+C directly on the focused, unopened cell, via DiskCell/DiffRow) so a value is copyable
// even before this surface is clicked open, but this component itself still has no clipboard code
// — it only ever hands modelValue's string to the surface below; the write lives one layer up.
// The surface commits nothing; that is the *only* difference between an immutable column and a
// mutable one.
describe('ScalarCell — immutable column activates a read-only text surface', () => {
  it('activates a readOnly input containing the value when clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toHaveAttribute('readonly');
  });

  it('returns to text on blur', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  // Issue #201: the whole value arrives pre-selected, so Ctrl+C is immediate and the highlight
  // itself is what signals "this is selectable". It also matters for a value wider than its
  // column: the input shows only part of a truncated composite, but select-on-focus means the
  // copy takes all of it.
  it('selects the whole value on focus, so Ctrl+C is immediate', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    const input = screen.getByDisplayValue('Dogmeat');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Dogmeat'.length);
  });

  // Issue #201 / ADR-0033: it must read as "you may select this", not "you may edit this" — an
  // input border and background would promise an edit the column cannot accept. The test DOM has
  // no cascade, so this proves only that the declarations are there, not which pixels paint.
  //
  // minWidth is load-bearing, not tidying, and is asserted here because this is where the style
  // lives: FormKeyCell wraps its content in `display: inline-flex`, which makes this input a flex
  // item, and a flex item's default `min-width: auto` refuses to shrink below its content — so
  // `width: 100%` would blow the column out instead of fitting it. Same trap #218 hit.
  it('is visibly inert — no input border or background', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    const input = screen.getByDisplayValue('Dogmeat');
    // Longhands, because happy-dom expands both shorthands to `'none none'` — and it echoes the
    // keyword into the longhand rather than resolving it (backgroundColor is `'none'`, not
    // `'transparent'`). Asserting the shorthand would read as a typo to the next person.
    expect(input.style.borderStyle).toBe('none');
    expect(input.style.backgroundColor).toBe('none');
    expect(input.style.minWidth).toBe('0');
  });

  // Issue #201, AC 5: `bool` and `enum` get the surface too — not because they were designed for,
  // but because the immutable branch sits *above* the type branches, so excluding them would take
  // extra code. These fence that ordering: if a type check ever creeps in above them, these fail
  // and the "not type-aware" claim in the ticket stops being true quietly.
  it('activates the same surface for a bool value', () => {
    render(<ScalarCell value={false} meta={boolMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('false'));
    expect(screen.getByDisplayValue('false')).toHaveAttribute('readonly');
  });

  it('activates the same surface for an enum, showing the rendered name', () => {
    render(<ScalarCell value="Male" meta={enumMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Male'));
    expect(screen.getByDisplayValue('Male')).toHaveAttribute('readonly');
  });

  // Issue #201 / ADR-0033: the em-dash is a placeholder, not a value — the same argument the ADR
  // already makes for `{…}` and `[3]` on struct/array summary rows. Activating a surface here
  // would hand over an empty selection that looks like a successful copy, which is worse than no
  // affordance at all.
  it('activates nothing on a null value — the em-dash is a placeholder', () => {
    render(<ScalarCell value={null} meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // The exception is one-sided: a mutable null cell must stay clickable, or there is no way to
  // give the field a value in the first place.
  it('still activates an editor on a null value in a mutable column', () => {
    render(<ScalarCell value={null} meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  // The surface exists so a value can be *read out*, never written. `readOnly` is what enforces
  // that in the browser; this is the fence around it, so a later refactor that swaps in a
  // controlled input with an onChange can't quietly make an immutable column stage edits.
  it('stages nothing when typed into and blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={false} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    const input = screen.getByDisplayValue('Dogmeat');
    fireEvent.change(input, { target: { value: 'Tampered' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('ScalarCell — read-only column', () => {
  it('shows the string value', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('shows "—" for null', () => {
    render(<ScalarCell value={null} meta={strMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows numeric value as text', () => {
    render(<ScalarCell value={42} meta={intMeta} editable={false} isFocused={false} onCommit={vi.fn()} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

// Issue #111: an editable cell renders as text until it is clicked — reading conflicts at a
// glance is the grid's primary job, so only the clicked cell becomes an input (xEdit's
// toEditOnClick). Commit or blur returns it to text.
describe('ScalarCell — editable column renders text until clicked', () => {
  it('renders text, not an input, before it is clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // Issue #204 / ADR-0033: the inactive-state span must not assert its own cursor — a mutable
  // cell is a drag source the whole time (DiskCell sets `grab` on the parent <td>), and an
  // inline `cursor: 'text'` here would visually mask that until the cell is actually clicked
  // into edit. jsdom can't prove which cursor paints (no cascade), so this only proves the
  // mask itself is gone.
  it('does not mask the parent drag cursor with its own cursor style before being clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    const textEl = screen.getByText('Dogmeat').parentElement!;
    expect(textEl.style.cursor).not.toBe('text');
  });

  // Issue #201: the editor selects on focus too. `autoFocus` alone leaves the caret at the end,
  // so pasting `5` into a cell showing `100` yields `1005` — the paste has to replace. Same line
  // also buys type-to-replace.
  it('selects the whole value on focus, so a paste replaces rather than appends', () => {
    render(<ScalarCell value="100" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('100'));
    const input = screen.getByDisplayValue('100');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it('swaps to a text input for string type when clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dogmeat').type).toBe('text');
  });

  it('returns to text on blur', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('renders a number input for int type when clicked', () => {
    render(<ScalarCell value={5} meta={intMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('5'));
    expect(screen.getByDisplayValue('5').type).toBe('number');
  });

  it('calls onCommit with a number (not a string) when int input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
    expect(typeof onCommit.mock.calls[0][0]).toBe('number');
  });

  it('calls onCommit with a float when float input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={1.5} meta={floatMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('1.5'));
    const input = screen.getByDisplayValue('1.5');
    fireEvent.change(input, { target: { value: '3.14' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(3.14);
  });

  it('swaps to a checkbox for bool type when clicked', () => {
    render(<ScalarCell value={false} meta={boolMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('false'));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox').checked).toBe(false);
  });

  // Activating a bool must not toggle it: a stray click would otherwise stage a change.
  it('does not commit merely by activating a bool cell', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('false'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('calls onCommit with true when the activated bool checkbox is clicked', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('false'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('swaps to a select with all enum options when clicked', () => {
    render(<ScalarCell value="Male" meta={enumMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Male'));
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Male' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Female' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
  });

  it('calls onCommit with Enter key on a text input', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="old" meta={strMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('old'));
    const input = screen.getByDisplayValue('old');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
  });
});

// Issue #223 / ADR-0034: xEdit's three open triggers on a mutable cell — a second click on the
// already-focused cell, F2 (exercised at the DiskCell/DiffRow seam, since it dispatches a click
// at this cell's own `data-open-trigger` element), and a double click. A first click on an
// unfocused cell only focuses (DiskCell's own onFocusCell) and must not also open.
describe('ScalarCell — mutable column gates opening on the focus check (#223)', () => {
  it('a click while not the focused cell does not open the editor', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('a click while already the focused cell opens the editor', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  it('a double click opens the editor even when not the focused cell', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  // The wiring F2 actually uses (DiskCell's querySelector) — this is the contract that dispatch
  // relies on: the mutable branch's clickable element carries the attribute, the immutable
  // branch's does not.
  it('marks the mutable open trigger with data-open-trigger', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat').closest('[data-open-trigger]')).not.toBeNull();
  });

  it('does not mark the immutable read-only-surface trigger with data-open-trigger', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} isFocused={true} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat').closest('[data-open-trigger]')).toBeNull();
  });
});

// Issue #111: click-to-activate puts every cell one mis-click away from staging. A change whose
// old value equals its new value is not an edit — it is noise in the Pending Changes tree, and
// it drags a whole ChangeGroup's dependency closure along with it (ADR-0028). The bool path
// guarded this from the start; every type needs it, because any cell can now be mis-clicked.
describe('ScalarCell — a no-op edit stages nothing', () => {
  it('does not commit when a text cell is activated and blurred without editing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when a number cell is activated and blurred without editing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    fireEvent.blur(screen.getByDisplayValue('5'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when an enum cell is activated and blurred without changing the selection', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Male" meta={enumMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Male'));
    fireEvent.blur(screen.getByRole('combobox'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when a text edit is typed and then reverted by hand before blur', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    const input = screen.getByDisplayValue('Dogmeat');
    fireEvent.change(input, { target: { value: 'Dogmeat!' } });
    fireEvent.change(input, { target: { value: 'Dogmeat' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit on Enter when the value is unchanged', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.keyDown(screen.getByDisplayValue('Dogmeat'), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The guard must not swallow a real edit that happens to round-trip through the same string.
  it('still commits a genuine change', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} isFocused={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
  });
});
