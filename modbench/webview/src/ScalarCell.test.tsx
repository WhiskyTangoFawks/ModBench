import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ScalarCell } from './ScalarCell';
import type { FieldMetadata } from './types';

/**
 * #415 AC1/AC4 at the cell: the record editor's one editing gesture is back, and it is xEdit's —
 * a click focuses, it does not edit (ADR-0034, root CLAUDE.md; specifying this from memory instead
 * of from xEdit is what cost #201/#204/#218). A column that cannot be written stays inert under
 * every one of the three open triggers, which is what "no silent dead UI" means at this level:
 * nothing opens that has nowhere to write.
 */
const meta = (over: Partial<FieldMetadata> = {}): FieldMetadata => ({
  name: 'value', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [], ...over,
});

describe('ScalarCell — the xEdit open gesture (#415)', () => {
  it('a first click on an unfocused cell focuses it and does not open an editor', () => {
    render(<ScalarCell value="before" meta={meta()} editable isFocused={false} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('before'));

    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a second click on the already-focused cell opens the editor', () => {
    render(<ScalarCell value="before" meta={meta()} editable isFocused onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('before'));

    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('a double click opens the editor even on a cell that was not focused', () => {
    render(<ScalarCell value="before" meta={meta()} editable isFocused={false} onCommit={vi.fn()} />);

    fireEvent.doubleClick(screen.getByText('before'));

    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('exposes the F2 trigger DiskCell clicks, and only while the cell is writable', () => {
    // F2 is dispatched by the containing cell at `[data-open-trigger]` — its presence *is* the
    // contract, so this asserts the attribute rather than simulating a key on the wrong element.
    const { container, rerender } = render(
      <ScalarCell value="before" meta={meta()} editable isFocused onCommit={vi.fn()} />);
    expect(container.querySelector('[data-open-trigger]')).toBeTruthy();

    rerender(<ScalarCell value="before" meta={meta()} editable={false} isFocused onCommit={vi.fn()} />);
    expect(container.querySelector('[data-open-trigger]')).toBeNull();
  });
});

describe('ScalarCell — a column with nowhere to write (#415 AC4)', () => {
  it('opens nothing under any of the three triggers', () => {
    const { container } = render(
      <ScalarCell value="before" meta={meta()} editable={false} isFocused onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('before'));
    fireEvent.doubleClick(screen.getByText('before'));

    expect(screen.queryByRole('textbox')).toBeNull();
    // No F2 target either — the key is inert here by construction, not by a second rule.
    expect(container.querySelector('[data-open-trigger]')).toBeNull();
  });

  it('renders as plain text when no commit target was supplied at all', () => {
    // The ordinary state for every caller outside the field grid: `editable` says yes but there is
    // nowhere to write, so the cell must not open an editor whose commit would go nowhere.
    render(<ScalarCell value="before" meta={meta()} editable />);

    fireEvent.doubleClick(screen.getByText('before'));

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ScalarCell — committing (#415 AC1)', () => {
  it('commits the typed value on Enter', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable isFocused onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('after');
  });

  it('commits a number as a number, not as the text that was typed', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={1} meta={meta({ type: 'float' })} editable isFocused onCommit={onCommit} />);
    fireEvent.click(screen.getByText('1'));

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0.75' } });
    fireEvent.blur(screen.getByRole('spinbutton'));

    expect(onCommit).toHaveBeenCalledWith(0.75);
  });

  it('does not commit a value equal to the one already there', () => {
    // A commit writes a ledger file. Re-typing the same value would produce a diff of nothing and
    // show the record as dirty in the Source Control panel for a keystroke the user never made.
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable isFocused onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'before' } });
    fireEvent.blur(screen.getByRole('textbox'));

    expect(onCommit).not.toHaveBeenCalled();
  });
});

// Issue #230 / ADR-0034 (#426: restored): `string` is the one type where double-click's target
// (the extended editor) differs from second-click/F2's (the inline editor) — so a genuine double
// click must not be preempted by the second click's own "open inline editor" handler firing
// first. The debounce only applies to a *real* mouse click (`detail >= 1` — what an actual click
// always carries): F2 dispatches its open via a real `.click()` call (DiskCell), which per the
// DOM spec carries `detail: 0`, and RTL's own `fireEvent.click` defaults to the same, which is
// why every plain `fireEvent.click` elsewhere in this file (never asserting anything about a
// following double click) keeps opening synchronously without needing changes here.
describe('ScalarCell — string double click opens the extended editor, debounced against a second click (#230)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a lone second click on an already-focused string cell still opens the inline editor, after the debounce', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable isFocused onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'), { detail: 1 });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  it('a genuine double click cancels the pending inline-open and calls onOpenExtended instead', () => {
    const onOpenExtended = vi.fn();
    render(
      <ScalarCell value="Dogmeat" meta={meta()} editable isFocused onCommit={vi.fn()} onOpenExtended={onOpenExtended} />,
    );
    fireEvent.click(screen.getByText('Dogmeat'), { detail: 1 });
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    act(() => { vi.advanceTimersByTime(300); });

    expect(onOpenExtended).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('a double click without onOpenExtended wired falls back to the inline editor (VMAD/Condition, #231)', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable isFocused onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  it('F2 (a real .click() call, detail 0) opens the inline editor immediately, with no debounce', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable isFocused onCommit={vi.fn()} onOpenExtended={vi.fn()} />);
    // F2's own dispatch mechanism (DiskCell): `element.click()`, which the DOM spec gives
    // `detail: 0` — the same default fireEvent.click uses when no override is given.
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  it('a non-string mutable type never debounces — dblclick still opens the inline editor directly', () => {
    render(<ScalarCell value={5} meta={meta({ type: 'int' })} editable isFocused onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('5'));
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
  });

  it('an immutable string cell opens nothing on double click when onOpenExtended is not wired', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('an immutable string cell calls onOpenExtended on double click when it is wired (read-only tab, AC5)', () => {
    const onOpenExtended = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} isFocused={false} onCommit={vi.fn()} onOpenExtended={onOpenExtended} />);
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    expect(onOpenExtended).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('an immutable non-string cell is unaffected — still opens nothing on double click', () => {
    render(<ScalarCell value={false} meta={meta({ type: 'bool' })} editable={false} isFocused={false} onCommit={vi.fn()} onOpenExtended={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('false'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  // The immutable string branch must not accidentally carry F2's own open-trigger marker — F2
  // opens nothing on an immutable cell (only double click does, and only for string), same
  // contract every other immutable cell already has.
  it('an immutable string cell with onOpenExtended still carries no data-open-trigger', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} isFocused={false} onCommit={vi.fn()} onOpenExtended={vi.fn()} />);
    expect(screen.getByText('Dogmeat').closest('[data-open-trigger]')).toBeNull();
  });
});
