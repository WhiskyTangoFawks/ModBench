import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const copyValue = vi.fn<(text: string) => void>();
const pickFormKey = vi.fn<(seed: string, validTypes: string[]) => Promise<string | null>>().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({
  copyValue: (text: string) => copyValue(text),
  pickFormKey: (seed: string, validTypes: string[]) => pickFormKey(seed, validTypes),
}));

import { DiskCell } from './DiskCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { fieldMeta } from './test/fixtures';

const renderCell = (props: Partial<React.ComponentProps<typeof DiskCell>> = {}, child: React.ReactNode = <span>cell</span>) =>
  render(
    <table><tbody><tr>
      <DiskCell style={{}} isFocused onFocusCell={vi.fn()} copyText="copied" {...props}>{child}</DiskCell>
    </tr></tbody></table>);

describe('DiskCell — the grid keys act only while no editor is open', () => {
  beforeEach(() => { copyValue.mockClear(); });

  it('Ctrl+C on the cell copies its value', () => {
    renderCell();
    fireEvent.keyDown(screen.getByText('cell'), { key: 'c', ctrlKey: true });
    expect(copyValue).toHaveBeenCalledWith('copied');
  });

  it('Ctrl+C in an open editor is left to the editor', () => {
    renderCell({}, <input data-editor aria-label="editor" />);
    const notPrevented = fireEvent.keyDown(screen.getByLabelText('editor'), { key: 'c', ctrlKey: true });
    expect(copyValue).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('Delete in an open editor does not remove the element', () => {
    const remove = vi.fn();
    renderCell({ arrayOps: { remove } }, <input data-editor aria-label="editor" />);
    fireEvent.keyDown(screen.getByLabelText('editor'), { key: 'Delete' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('F2 in an open editor does not open another', () => {
    const open = vi.fn();
    renderCell({}, <><button data-open-trigger onClick={open}>open</button><input data-editor aria-label="editor" /></>);
    fireEvent.keyDown(screen.getByLabelText('editor'), { key: 'F2' });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('DiskCell — a key focus is the user entering the cell', () => {
  it('focusing the unfocused cell with the keyboard focuses it in the grid', () => {
    const onFocusCell = vi.fn();
    const { container } = renderCell({ isFocused: false, onFocusCell });
    container.querySelector('td')?.focus();
    expect(onFocusCell).toHaveBeenCalledTimes(1);
  });

  it('focus moving inside the cell, to an editor, is not a new focus', () => {
    const onFocusCell = vi.fn();
    renderCell({ isFocused: false, onFocusCell }, <input aria-label="editor" />);
    screen.getByLabelText('editor').focus();
    expect(onFocusCell).not.toHaveBeenCalled();
  });
});

describe('DiskCell — one gesture opens one editor', () => {
  const scalar = <ScalarCell value="before" meta={fieldMeta({ name: 'value', type: 'string' })} editable onCommit={vi.fn()} />;
  const reference = (
    <FormKeyCell
      value="000019:Fallout4.esm" meta={fieldMeta({ name: 'Race', type: 'formKey', validFormKeyTypes: ['race'] })}
      editable onOpen={vi.fn()} onCommit={vi.fn()}
    />);
  const cellOf = (container: HTMLElement) => {
    const td = container.querySelector('td');
    if (!td) throw new Error('no cell');
    return td;
  };

  beforeEach(() => { pickFormKey.mockReset().mockReturnValue(new Promise(() => undefined)); });

  it('a second click on the padding of the focused cell opens the editor', () => {
    const { container } = renderCell({}, scalar);
    fireEvent.click(cellOf(container));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('a first click on the value of an unfocused cell only focuses it', () => {
    const onFocusCell = vi.fn();
    renderCell({ isFocused: false, onFocusCell }, scalar);
    fireEvent.click(screen.getByText('before'));
    expect(onFocusCell).toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a first click on the padding of an unfocused cell only focuses it', () => {
    const onFocusCell = vi.fn();
    const { container } = renderCell({ isFocused: false, onFocusCell }, scalar);
    fireEvent.click(cellOf(container));
    expect(onFocusCell).toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a double click on a focused cell opens one editor', () => {
    renderCell({}, scalar);
    fireEvent.click(screen.getByText('before'));
    fireEvent.doubleClick(screen.getByRole('textbox'));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('a double click on an unfocused reference cell, with its clicks, opens one picker', () => {
    const { rerender } = renderCell({ isFocused: false }, reference);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.click(link);
    rerender(
      <table><tbody><tr><DiskCell style={{}} isFocused onFocusCell={vi.fn()}>{reference}</DiskCell></tr></tbody></table>);
    fireEvent.click(link);
    fireEvent.doubleClick(link);
    expect(pickFormKey).toHaveBeenCalledTimes(1);
  });

  it('a double click alone opens the editor', () => {
    renderCell({ isFocused: false }, scalar);
    fireEvent.doubleClick(screen.getByText('before'));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('F2 opens the same editor', () => {
    const { container } = renderCell({}, scalar);
    fireEvent.keyDown(cellOf(container), { key: 'F2' });
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
