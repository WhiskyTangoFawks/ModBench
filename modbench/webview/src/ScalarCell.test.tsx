import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { vscode } from './vscode';
import type { EnumChoice } from '../../src/wire/messages';
import { ScalarCell } from './ScalarCell';
import type { FieldMetadata } from './types';
import { fieldMeta, hostPickingEnum } from './test/fixtures';

const meta = (over: Partial<FieldMetadata> = {}): FieldMetadata =>
  fieldMeta({ name: 'value', type: 'string', ...over });

describe('ScalarCell — the xEdit open gesture', () => {
  it('the open trigger opens the editor', () => {
    render(<ScalarCell value="before" meta={meta()} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('before'));

    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

describe('ScalarCell — typed text is taken as pasted text is', () => {
  it('a whole number types as the number', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={meta({ type: 'int' })} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: '12' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith(12);
  });
});

describe('ScalarCell — a colour cell shows a swatch of the colour beside its text', () => {
  it('draws the swatch in the colour the text names, with its alpha', () => {
    render(<ScalarCell value="80FF8000" meta={meta({ type: 'color', holdsAlpha: true })} />);

    expect(screen.getByText('#80FF8000')).toBeInTheDocument();
    expect(screen.getByTestId('colour-swatch')).toHaveStyle({ backgroundColor: 'rgba(255, 128, 0, 0.5019607843137255)' });
  });

  it('draws an opaque colour that holds no alpha', () => {
    render(<ScalarCell value="#FF8000" meta={meta({ type: 'color', holdsAlpha: false })} />);

    expect(screen.getByText('#FF8000')).toBeInTheDocument();
    expect(screen.getByTestId('colour-swatch')).toHaveStyle({ backgroundColor: 'rgb(255, 128, 0)' });
  });

  it('draws no swatch for a value that is not a colour, nor for a string that looks like one', () => {
    const { rerender } = render(<ScalarCell value="not a colour" meta={meta({ type: 'color' })} />);
    expect(screen.queryByTestId('colour-swatch')).toBeNull();

    rerender(<ScalarCell value="#FF8000" meta={meta({ type: 'string' })} />);
    expect(screen.queryByTestId('colour-swatch')).toBeNull();
  });

  it('leaves a float that happens to have six digits as it is', () => {
    render(<ScalarCell value={123456} meta={meta({ type: 'float' })} />);

    expect(screen.getByText('123456')).toBeInTheDocument();
  });
});

describe('ScalarCell — a placed reference rotation shows its degrees beside the radians', () => {
  const rotation = meta({ type: 'vector', isPlacedRotation: true });

  it('reads the radians as they are, then the degrees', () => {
    render(<ScalarCell value="3.1415927, 0, 1.5707964" meta={rotation} />);

    expect(screen.getByText('3.1415927, 0, 1.5707964')).toBeInTheDocument();
    expect(screen.getByText('(180°, 0°, 90°)')).toBeInTheDocument();
  });

  it('shows no degrees for a vector the schema does not mark', () => {
    render(<ScalarCell value="3.1415927, 0, 1.5707964" meta={meta({ type: 'vector' })} />);

    expect(screen.queryByText(/°/)).toBeNull();
  });

  it('edits the radians', () => {
    render(<ScalarCell value="1, 2, 3" meta={rotation} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('1, 2, 3'));

    expect(screen.getByRole('textbox')).toHaveValue('1, 2, 3');
  });
});

describe('ScalarCell — a column with nowhere to write', () => {
  it('renders as plain text when no commit target was supplied, the ordinary state for every caller outside the field grid', () => {
    render(<ScalarCell value="before" meta={meta()} />);

    fireEvent.click(screen.getByText('before'));

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ScalarCell — a value equal to the one already there is not an edit, which would show the record as dirty in Source Control for a keystroke the user never made', () => {
  it.each([
    ['a string', meta(), 'before', 'before'],
    ['a translated string', meta({ name: 'Name', type: 'translatedString' }), { TargetLanguage: 'English', Value: 'Base name' }, 'Base name'],
  ])('%s commits nothing when closed on the text it already holds', (_case, cellMeta, value, text) => {
    const onCommit = vi.fn();
    render(<ScalarCell value={value} meta={cellMeta} onCommit={onCommit} />);
    fireEvent.click(screen.getByText(text));

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('ScalarCell — a hex row edits as text because the schema says the field is hex, never because the value looks like hex', () => {
  const hexMeta = meta({ name: 'unknown3', type: 'hex' });

  it('edits as text and commits the typed hex verbatim', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="0x11223344" meta={hexMeta} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('0x11223344'));
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('type')).toBe('text');

    fireEvent.change(input, { target: { value: '0xAABBCCDD' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('0xAABBCCDD');
  });

  it('hands a value the writer will refuse straight through, rather than silently correcting it', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="0x11223344" meta={hexMeta} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('0x11223344'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '0xNOTHEX' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('0xNOTHEX');
  });
});

describe('ScalarCell — an enum is picked from the host\'s quick pick', () => {
  const kind = meta({
    name: 'MutagenObjectType', type: 'enum',
    enumMembers: [{ value: 'PcLevelMult', label: 'Pc Level Mult' }, { value: 'NpcLevel', label: 'Npc Level' }],
  });
  const asked: { choices: EnumChoice[]; current: string }[] = [];
  const hostChoosing = (value: string | null) => {
    vi.mocked(vscode.postMessage).mockImplementation(hostPickingEnum((choices, current) => {
      asked.push({ choices, current });
      return value;
    }));
  };
  beforeEach(() => { asked.length = 0; });

  it('shows the label at rest, never the value behind it', () => {
    render(<ScalarCell value="NpcLevel" meta={kind} onCommit={vi.fn()} />);

    expect(screen.getByText('Npc Level')).toBeInTheDocument();
    expect(screen.queryByText('NpcLevel')).toBeNull();
  });

  it('opens no in-page control, and asks for the names sorted, opening on the current value', () => {
    hostChoosing(null);
    render(<ScalarCell value="NpcLevel" meta={kind} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('Npc Level'));

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(asked).toEqual([{
      choices: [{ value: 'NpcLevel', label: 'Npc Level' }, { value: 'PcLevelMult', label: 'Pc Level Mult' }],
      current: 'NpcLevel',
    }]);
  });

  it('falls back to the values themselves for an ordinary enum, which has no labels', () => {
    hostChoosing(null);
    const plain = meta({ type: 'enum', enumMembers: [{ value: 'Beta' }, { value: 'Alpha' }] });
    render(<ScalarCell value="Alpha" meta={plain} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('Alpha'));

    expect(asked[0]?.choices.map(c => c.label)).toEqual(['Alpha', 'Beta']);
  });

  it('commits the chosen name\'s own value, not the label the user read', async () => {
    hostChoosing('PcLevelMult');
    const onCommit = vi.fn();
    render(<ScalarCell value="NpcLevel" meta={kind} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('Npc Level'));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('PcLevelMult'));
  });

  it('writes nothing when the pick is dismissed', async () => {
    hostChoosing(null);
    const onCommit = vi.fn();
    render(<ScalarCell value="NpcLevel" meta={kind} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('Npc Level'));
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('writes nothing when the choice is the current value', async () => {
    hostChoosing('NpcLevel');
    const onCommit = vi.fn();
    render(<ScalarCell value="NpcLevel" meta={kind} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('Npc Level'));
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('lists a value the enum does not name as <Unknown: n>, the current one, and choosing it writes nothing', async () => {
    hostChoosing('5');
    const onCommit = vi.fn();
    const numbered = meta({ type: 'enum', enumMembers: [{ value: 'A' }, { value: 'B' }] });
    render(<ScalarCell value={5} meta={numbered} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('<Unknown: 5>'));
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });

    expect(asked[0]?.current).toBe('5');
    expect(asked[0]?.choices).toContainEqual({ value: '5', label: '<Unknown: 5>' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('ScalarCell — a translated string, which the codec spells as an object whose `Value` is the text', () => {
  const nameMeta = meta({ name: 'Name', type: 'translatedString' });
  const value = { TargetLanguage: 'English', Value: 'Base name' };

  it('reads the text, not the object', () => {
    render(<ScalarCell value={value} meta={nameMeta} onCommit={vi.fn()} />);
    expect(screen.getByText('Base name')).toBeInTheDocument();
    expect(screen.queryByText(/TargetLanguage/)).toBeNull();
  });

  it('commits the typed text', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={value} meta={nameMeta} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Base name'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('New name');
  });
});

describe('ScalarCell — Enter writes and Esc cancels', () => {
  it('Esc closes the text editor and writes nothing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('before')).toBeTruthy();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Enter writes the text once and closes the editor', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('after');
  });

  it('moving the focus away writes the text', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="before" meta={meta()} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.blur(screen.getByRole('textbox'));

    expect(onCommit).toHaveBeenCalledWith('after');
  });

  it('Esc hands the focus back to the cell without the blur writing the text', () => {
    const onCommit = vi.fn();
    render(
      <table><tbody><tr><td tabIndex={0} data-testid="cell">
        <ScalarCell value="before" meta={meta()} onCommit={onCommit} />
      </td></tr></tbody></table>);
    fireEvent.click(screen.getByText('before'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'after' } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.getByTestId('cell')).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('draws the checkbox editor in the theme\'s checkbox style', () => {
    render(<ScalarCell value={false} meta={meta({ type: 'bool' })} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('False'));

    expect(screen.getByRole('checkbox')).toHaveClass('vscode-checkbox');
  });

  it('Esc closes the checkbox editor', () => {
    render(<ScalarCell value={false} meta={meta({ type: 'bool' })} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('False'));

    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Escape' });

    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
