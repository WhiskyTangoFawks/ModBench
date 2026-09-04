import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScalarCell } from './ScalarCell';
import type { FieldMetadata } from './types';

// ADR-0034: a click focuses, it does not edit, and a column that cannot be written stays inert
// under every open trigger — nothing opens that has nowhere to write.
const meta = (over: Partial<FieldMetadata> = {}): FieldMetadata => ({
  name: 'value', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [], ...over,
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

  it('commits exactly once on Enter, though Enter also blurs the input', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable isFocused onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'after' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledTimes(1);
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

// ADR-0039: a genuine mouse click on an already-focused string cell opens the inline editor
// synchronously — no left click may cost latency waiting to see whether a second is coming.
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

// ADR-0039: an immutable string cell is unaffected by any left-click gesture; its only read
// path for a long value is the right-click menu.
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

// A hex row edits as text because the schema says the field is hex, never because the value
// looks like hex; the wrong-length and non-hex refusals are the writer's.
describe('ScalarCell — a hex row (#690)', () => {
  const hexMeta = meta({ name: 'unknown3', type: 'hex' });

  it('edits as text and commits the typed hex verbatim', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="0x11223344" meta={hexMeta} editable isFocused onCommit={onCommit} />);

    fireEvent.click(screen.getByText('0x11223344'));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('type')).toBe('text');

    fireEvent.change(input, { target: { value: '0xAABBCCDD' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('0xAABBCCDD');
  });

  it('hands a value the writer will refuse straight through, rather than silently correcting it', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="0x11223344" meta={hexMeta} editable isFocused onCommit={onCommit} />);

    fireEvent.click(screen.getByText('0x11223344'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '0xNOTHEX' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('0xNOTHEX');
  });
});

// An abstract union's `concrete_type` holds Mutagen class names, not words: the schema labels
// each member, and the cell shows the label but commits the value behind it.
describe('ScalarCell — an enum whose values are wire tokens (#688)', () => {
  const kind = meta({
    name: 'concrete_type', type: 'enum',
    enumMembers: [{ value: 'NpcLevel', label: 'Npc Level' },
      { value: 'PcLevelMult', label: 'Pc Level Mult' }],
  });

  it('shows the label at rest, never the value behind it', () => {
    render(<ScalarCell value="NpcLevel" meta={kind} editable onCommit={vi.fn()} />);

    expect(screen.getByText('Npc Level')).toBeInTheDocument();
    expect(screen.queryByText('NpcLevel')).toBeNull();
  });

  it('commits the chosen option\'s own value, not the label the user read', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="NpcLevel" meta={kind} editable onCommit={onCommit} />);
    fireEvent.doubleClick(screen.getByText('Npc Level'));

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'PcLevelMult' } });
    fireEvent.blur(select);

    expect(onCommit).toHaveBeenCalledWith('PcLevelMult');
  });

  it('falls back to the values themselves for an ordinary enum, which has no labels', () => {
    const plain = meta({ type: 'enum', enumMembers: [{ value: 'Alpha' }, { value: 'Beta' }] });
    render(<ScalarCell value="Alpha" meta={plain} editable onCommit={vi.fn()} />);

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('Alpha'));
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Alpha', 'Beta']);
  });
});
