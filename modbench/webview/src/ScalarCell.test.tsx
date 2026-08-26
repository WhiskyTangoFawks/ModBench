import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    // A commit writes a source file. Re-typing the same value would produce a diff of nothing and
    // show the record as dirty in the Source Control panel for a keystroke the user never made.
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable isFocused onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'before' } });
    fireEvent.blur(screen.getByRole('textbox'));

    expect(onCommit).not.toHaveBeenCalled();
  });
});

// #258 / ADR-0039 guard: a genuine mouse click (detail >= 1, what a real click always carries —
// see the file's own #230 describe block below for why detail 0 is F2's own signature, not a
// click's) on an already-focused string cell must open the inline editor *synchronously*, with no
// debounce delay of any kind. Named rival this is checked against: the pre-#258 debounced
// implementation, which defers this behind STRING_OPEN_DEBOUNCE_MS so a following native
// `dblclick` can still redirect it — that rival fails this test outright (the textbox does not
// exist until the timer is advanced), which is the point: no left click may cost latency waiting
// to see whether a second one is coming.
describe('ScalarCell — string cell has no debounce (#258 / ADR-0039)', () => {
  it('a genuine second click on an already-focused string cell opens the inline editor immediately', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable isFocused onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'), { detail: 1 });
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  it('a double click on a mutable string cell opens the inline editor, matching every other type', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable isFocused onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });
});

// #258 / ADR-0039: an immutable string cell is unaffected by any left-click gesture, exactly like
// every other immutable type — its only remaining read path for a long value is the right-click
// menu (DiffRow's own stringValueContext wiring, tested there), not anything ScalarCell itself
// handles any more.
describe('ScalarCell — immutable string cell (#258 / ADR-0039)', () => {
  it('opens nothing on double click', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} isFocused={false} onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('carries no data-open-trigger, same as every other immutable cell', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} isFocused={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat').closest('[data-open-trigger]')).toBeNull();
  });
});
