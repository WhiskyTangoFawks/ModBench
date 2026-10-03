import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScalarCell } from './ScalarCell';
import type { FieldMetadata } from './types';
import { fieldMeta } from './test/fixtures';

const meta = (over: Partial<FieldMetadata> = {}): FieldMetadata =>
  fieldMeta({ name: 'value', type: 'string', ...over });

describe('ScalarCell — the xEdit open gesture: a click focuses, it does not edit', () => {
  it('the open trigger opens the editor', () => {
    render(<ScalarCell value="before" meta={meta()} editable onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('before'));

    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('exposes the F2 trigger DiskCell clicks, the containing cell dispatching F2 at `[data-open-trigger]`, and only while the cell is writable', () => {
    const { container, rerender } = render(
      <ScalarCell value="before" meta={meta()} editable onCommit={vi.fn()} />);
    expect(container.querySelector('[data-open-trigger]')).toBeTruthy();

    rerender(<ScalarCell value="before" meta={meta()} editable={false} onCommit={vi.fn()} />);
    expect(container.querySelector('[data-open-trigger]')).toBeNull();
  });
});

describe('ScalarCell — typed text is taken as pasted text is', () => {
  const typeAndEnter = (cellMeta: FieldMetadata, value: unknown, text: string) => {
    const onCommit = vi.fn();
    render(<ScalarCell value={value} meta={cellMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText(String(value)));
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
    return onCommit;
  };

  it('a whole number types as the number', () => {
    expect(typeAndEnter(meta({ type: 'int' }), 5, '12')).toHaveBeenCalledWith(12);
  });

  it('a fraction in an integer field is not repaired to a whole number', () => {
    expect(typeAndEnter(meta({ type: 'int' }), 5, '1.5')).toHaveBeenCalledWith('1.5');
  });

  it('a decimal in a float field types as the number', () => {
    expect(typeAndEnter(meta({ type: 'float' }), 5, '1.5')).toHaveBeenCalledWith(1.5);
  });
});

describe('ScalarCell — a column with nowhere to write', () => {
  it('opens nothing under any of the three triggers', () => {
    const { container } = render(
      <ScalarCell value="before" meta={meta()} editable={false} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('before'));
    fireEvent.click(screen.getByText('before'));

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('[data-open-trigger]')).toBeNull();
  });

  it('renders as plain text when no commit target was supplied at all, the ordinary state for every caller outside the field grid', () => {
    render(<ScalarCell value="before" meta={meta()} editable />);

    fireEvent.click(screen.getByText('before'));

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ScalarCell — committing', () => {
  it('commits the typed value on Enter', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('after');
  });

  it('commits exactly once on Enter, though Enter also blurs the input', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'after' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits a number as a number, not as the text that was typed', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={1} meta={meta({ type: 'float' })} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('1'));

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0.75' } });
    fireEvent.blur(screen.getByRole('spinbutton'));

    expect(onCommit).toHaveBeenCalledWith(0.75);
  });

  it('does not commit a value equal to the one already there, which would show the record as dirty in Source Control for a keystroke the user never made', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'before' } });
    fireEvent.blur(screen.getByRole('textbox'));

    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('ScalarCell — string cell has no debounce: no left click waits to see whether a second is coming',() => {
  it('a genuine second click on an already-focused string cell opens the inline editor immediately', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'), { detail: 1 });
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });

  it('a double click on a mutable string cell opens the inline editor, matching every other type', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
  });
});

describe('ScalarCell — immutable string cell is unaffected by any left-click gesture, its only read path for a long value being the right-click menu',() => {
  it('opens nothing on double click', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('carries no data-open-trigger, same as every other immutable cell', () => {
    render(<ScalarCell value="Dogmeat" meta={meta()} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat').closest('[data-open-trigger]')).toBeNull();
  });
});

describe('ScalarCell — a hex row edits as text because the schema says the field is hex, never because the value looks like hex',() => {
  const hexMeta = meta({ name: 'unknown3', type: 'hex' });

  it('edits as text and commits the typed hex verbatim', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="0x11223344" meta={hexMeta} editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText('0x11223344'));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('type')).toBe('text');

    fireEvent.change(input, { target: { value: '0xAABBCCDD' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('0xAABBCCDD');
  });

  it('hands a value the writer will refuse straight through, rather than silently correcting it', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="0x11223344" meta={hexMeta} editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText('0x11223344'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '0xNOTHEX' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('0xNOTHEX');
  });
});

describe('ScalarCell — an enum whose values are wire tokens, as an abstract union\'s `MutagenObjectType` holds Mutagen class names, not words',() => {
  const kind = meta({
    name: 'MutagenObjectType', type: 'enum',
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
    fireEvent.click(screen.getByText('Npc Level'));

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'PcLevelMult' } });
    fireEvent.blur(select);

    expect(onCommit).toHaveBeenCalledWith('PcLevelMult');
  });

  it('falls back to the values themselves for an ordinary enum, which has no labels', () => {
    const plain = meta({ type: 'enum', enumMembers: [{ value: 'Alpha' }, { value: 'Beta' }] });
    render(<ScalarCell value="Alpha" meta={plain} editable onCommit={vi.fn()} />);

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Alpha', 'Beta']);
  });
});

describe('ScalarCell — a translated string, which the codec spells as an object whose `Value` is the text',() => {
  const nameMeta = meta({ name: 'Name', type: 'translatedString' });
  const value = { TargetLanguage: 'English', Value: 'Base name' };

  it('reads the text, not the object', () => {
    render(<ScalarCell value={value} meta={nameMeta} editable onCommit={vi.fn()} />);
    expect(screen.getByText('Base name')).toBeInTheDocument();
    expect(screen.queryByText(/TargetLanguage/)).toBeNull();
  });

  it('commits the object with the typed text as its Value, keeping the rest', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={value} meta={nameMeta} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Base name'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith({ TargetLanguage: 'English', Value: 'New name' });
  });

  it('commits a bare object from an absent value', () => {
    const onCommit = vi.fn();
    const { container } = render(<ScalarCell value={null} meta={nameMeta} editable onCommit={onCommit} />);
    const openTrigger = container.querySelector('[data-open-trigger]');
    if (!openTrigger) throw new Error('expected an open trigger on a bare-object cell with an absent value');
    fireEvent.click(openTrigger);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Named' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith({ Value: 'Named' });
  });
});

describe('ScalarCell — Enter writes and Esc cancels', () => {
  const enumMeta = () => meta({
    type: 'enum',
    enumMembers: [{ value: 'A' }, { value: 'B' }],
  });

  it('Esc closes the text editor and writes nothing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('before')).toBeTruthy();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Enter writes the text once and closes the editor', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('after');
  });

  it('moving the focus away writes the text', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.blur(screen.getByRole('textbox'));

    expect(onCommit).toHaveBeenCalledWith('after');
  });

  it('Enter in the enum dropdown writes the chosen member and closes it', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="A" meta={enumMeta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'B' } });

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('B');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('Esc in the enum dropdown closes it and writes nothing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="A" meta={enumMeta()} editable onCommit={onCommit} />);
    fireEvent.click(screen.getByText('A'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'B' } });

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Esc hands the focus back to the cell without the blur writing the text', () => {
    const onCommit = vi.fn();
    render(
      <table><tbody><tr><td tabIndex={0} data-testid="cell">
        <ScalarCell value="before" meta={meta()} editable onCommit={onCommit} />
      </td></tr></tbody></table>);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.getByTestId('cell')).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Esc closes the checkbox editor', () => {
    render(<ScalarCell value={false} meta={meta({ type: 'bool' })} editable onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('False'));

    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Escape' });

    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
