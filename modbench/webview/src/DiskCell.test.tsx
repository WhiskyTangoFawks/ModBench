import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const copyValue = vi.fn<(text: string) => void>();
vi.mock('./nativeBridge', () => ({ copyValue: (text: string) => copyValue(text) }));

import { DiskCell } from './DiskCell';

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
