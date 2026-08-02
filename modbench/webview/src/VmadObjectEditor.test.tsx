import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Issue #210: VmadObjectEditor no longer renders an inline picker — a click on the FK button
// now calls pickFormKey (the native-QuickPick bridge) instead. Mocked here so these tests
// assert the call (seed), not any rendered picker DOM.
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({ pickFormKey: (...args: unknown[]) => pickFormKey(...args) }));

import { VmadObjectEditor } from './VmadObjectEditor';

// Moved from VmadSection.test.tsx (issue #125): this asserted only that the editor's FK button
// and alias input render with the parsed disk value — no VMAD path, no coordinator wiring — so
// it moves to exercise the editor directly instead of through a full section mount + click.
describe('VmadObjectEditor — renders the FK button and alias input', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('parses "FormKey [alias]" into the button label and the alias input value', () => {
    render(<VmadObjectEditor value="000123:Foo.esp [2]" onCommit={vi.fn()} />);
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(2);
  });

  it('shows placeholder text when the FormKey is empty', () => {
    render(<VmadObjectEditor value="" onCommit={vi.fn()} />);
    expect(screen.getByText('— click to pick')).toBeInTheDocument();
  });
});

describe('VmadObjectEditor — alias edits', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('commits { formKey, alias } on blur after changing the alias', () => {
    const onCommit = vi.fn();
    render(<VmadObjectEditor value="000123:Foo.esp [2]" onCommit={onCommit} />);
    const aliasInput = screen.getByLabelText('Alias');
    fireEvent.change(aliasInput, { target: { value: '5' } });
    fireEvent.blur(aliasInput);
    expect(onCommit).toHaveBeenCalledWith({ formKey: '000123:Foo.esp', alias: 5 });
  });

  it('resets to the disk value when the value prop changes externally', () => {
    const { rerender } = render(<VmadObjectEditor value="000123:Foo.esp [2]" onCommit={vi.fn()} />);
    rerender(<VmadObjectEditor value="000456:Bar.esp [9]" onCommit={vi.fn()} />);
    expect(screen.getByText('000456:Bar.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(9);
  });
});

describe('VmadObjectEditor — picking a FormKey', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  // Issue #210: seeded with the current reference (the FormKey the button shows), same fix as
  // FormKeyCell — the picker needs to show what it's replacing.
  it('clicking the button opens the picker seeded with the current FormKey', () => {
    render(<VmadObjectEditor value="000123:Foo.esp [2]" onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    expect(pickFormKey).toHaveBeenCalledWith('000123:Foo.esp', []);
  });

  it('commits { formKey, alias } when pickFormKey resolves with a selection', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('000789:Baz.esp');
    render(<VmadObjectEditor value="000123:Foo.esp [2]" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith({ formKey: '000789:Baz.esp', alias: 2 }));
    expect(screen.getByText('000789:Baz.esp')).toBeInTheDocument();
  });

  it('leaves the field unchanged when pickFormKey resolves null (Escape/blur)', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce(null);
    render(<VmadObjectEditor value="000123:Foo.esp [2]" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
  });
});
