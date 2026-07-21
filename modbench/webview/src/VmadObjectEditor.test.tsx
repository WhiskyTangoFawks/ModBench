import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { VmadObjectEditor } from './VmadObjectEditor';
import type { RecordSessionClient } from './RecordSessionClient';

// Issue #122: the object leaf editor takes the injected client, no port. These tests don't
// drive a live search, so a stub whose presence just enables the picker branch is enough.
const stubClient = { searchRecords: vi.fn().mockResolvedValue([]) } as unknown as RecordSessionClient;

// Moved from VmadSection.test.tsx (issue #125): this asserted only that the editor's FK button
// and alias input render with the parsed disk value — no VMAD path, no coordinator wiring — so
// it moves to exercise the editor directly instead of through a full section mount + click.
describe('VmadObjectEditor — renders the FK button and alias input', () => {
  it('parses "FormKey [alias]" into the button label and the alias input value', () => {
    render(<VmadObjectEditor value="000123:Foo.esp [2]" client={stubClient} onCommit={vi.fn()} />);
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(2);
  });

  it('shows placeholder text when the FormKey is empty', () => {
    render(<VmadObjectEditor value="" client={stubClient} onCommit={vi.fn()} />);
    expect(screen.getByText('— click to pick')).toBeInTheDocument();
  });
});

describe('VmadObjectEditor — alias edits', () => {
  it('commits { formKey, alias } on blur after changing the alias', () => {
    const onCommit = vi.fn();
    render(<VmadObjectEditor value="000123:Foo.esp [2]" client={stubClient} onCommit={onCommit} />);
    const aliasInput = screen.getByLabelText('Alias');
    fireEvent.change(aliasInput, { target: { value: '5' } });
    fireEvent.blur(aliasInput);
    expect(onCommit).toHaveBeenCalledWith({ formKey: '000123:Foo.esp', alias: 5 });
  });

  it('resets to the disk value when the value prop changes externally', () => {
    const { rerender } = render(<VmadObjectEditor value="000123:Foo.esp [2]" client={stubClient} onCommit={vi.fn()} />);
    rerender(<VmadObjectEditor value="000456:Bar.esp [9]" client={stubClient} onCommit={vi.fn()} />);
    expect(screen.getByText('000456:Bar.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(9);
  });
});

describe('VmadObjectEditor — picking a FormKey', () => {
  it('clicking the button opens the picker instead of the button', () => {
    render(<VmadObjectEditor value="000123:Foo.esp [2]" client={stubClient} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
    expect(screen.queryByText('000123:Foo.esp')).not.toBeInTheDocument();
  });
});
