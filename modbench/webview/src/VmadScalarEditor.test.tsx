import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { VmadScalarEditor } from './VmadScalarEditor';

// Moved from VmadSection.test.tsx (issue #125): this asserted only that a Bool leaf renders as
// a checkbox — no VMAD path, no coordinator wiring — so it moves to exercise the editor
// directly instead of through a full section mount + click-to-activate.
describe('VmadScalarEditor — bool type renders a checkbox', () => {
  it('renders a checkbox reflecting the current value', () => {
    render(<VmadScalarEditor value={false} type="bool" onCommit={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('checking it commits true', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value={false} type="bool" onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(true);
  });
});

describe('VmadScalarEditor — int/float/string types render a text or number input', () => {
  it('renders a number input for int, seeded with the string form of the value', () => {
    render(<VmadScalarEditor value={5} type="int" onCommit={vi.fn()} />);
    expect(screen.getByRole('spinbutton')).toHaveValue(5);
  });

  it('renders a number input for float', () => {
    render(<VmadScalarEditor value={1.5} type="float" onCommit={vi.fn()} />);
    expect(screen.getByRole('spinbutton')).toHaveValue(1.5);
  });

  it('renders a text input for string', () => {
    render(<VmadScalarEditor value="old" type="string" onCommit={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('old');
  });

  it('commits a parsed int on blur', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value={5} type="int" onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it('commits a parsed float on blur', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value={1.5} type="float" onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '3.14' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(3.14);
  });

  it('commits the raw string on blur for type string', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value="old" type="string" onCommit={onCommit} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('new');
  });

  // An unparseable numeric edit falls back to the original value rather than committing NaN.
  it('falls back to the original value when an int edit does not parse', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value={5} type="int" onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(5);
  });

  it('falls back to the original value when a float edit does not parse', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value={1.5} type="float" onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(1.5);
  });

  it('commits and blurs on Enter', () => {
    const onCommit = vi.fn();
    render(<VmadScalarEditor value="old" type="string" onCommit={onCommit} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
  });

  it('resets the draft when the value prop changes externally', () => {
    const { rerender } = render(<VmadScalarEditor value={5} type="int" onCommit={vi.fn()} />);
    rerender(<VmadScalarEditor value={9} type="int" onCommit={vi.fn()} />);
    expect(screen.getByRole('spinbutton')).toHaveValue(9);
  });

  it('applies the given aria-label', () => {
    render(<VmadScalarEditor value={5} type="int" onCommit={vi.fn()} ariaLabel="Added value for X" />);
    expect(screen.getByLabelText('Added value for X')).toBeInTheDocument();
  });
});
