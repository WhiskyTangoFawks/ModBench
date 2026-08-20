import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Issue #210: VmadObjectEditor imports the pickFormKey bridge indirectly, via the shared
// FormKeyCell it now composes — mocked here so these tests assert the call (seed, valid types),
// not any rendered picker DOM.
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({ pickFormKey: (...args: unknown[]) => pickFormKey(...args) }));

import { VmadObjectEditor } from './VmadObjectEditor';

// Issue #229: VmadObjectEditor now owns its own read/edit toggle (the deleted ClickToEdit's job,
// folded in here since the shared FormKeyCell has no concept of the alias paired with it) — every
// test supplies a `read` fixture and, where the editor itself is under test, clicks it first,
// exactly like real usage does.
const READ = <span>read placeholder</span>;

function renderInactive(value: unknown, onCommit = vi.fn(), onOpen = vi.fn()) {
  const utils = render(<VmadObjectEditor value={value} read={READ} onCommit={onCommit} onOpen={onOpen} />);
  return { ...utils, onCommit, onOpen };
}

function activate() {
  fireEvent.click(screen.getByText('read placeholder'));
}

describe('VmadObjectEditor — inactive state shows only the supplied read content', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('renders the read content and no editor before any click', () => {
    renderInactive('000123:Foo.esp [2]');
    expect(screen.getByText('read placeholder')).toBeInTheDocument();
    expect(screen.queryByLabelText('Alias')).not.toBeInTheDocument();
  });

  it('a plain click reveals the FormKey cell and alias input', () => {
    renderInactive('000123:Foo.esp [2]');
    activate();
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(2);
  });

  it('a Ctrl+click does not activate the editor', () => {
    renderInactive('000123:Foo.esp [2]');
    fireEvent.click(screen.getByText('read placeholder'), { ctrlKey: true });
    expect(screen.queryByLabelText('Alias')).not.toBeInTheDocument();
  });
});

// #426 Track 5: unlike the pre-#410 version (which opened unconditionally on any click), an
// absent `onCommit` — the same "nowhere to write" signal every other leaf uses — now refuses to
// open at all, matching ADR-0034's "an immutable cell simply refuses."
describe('VmadObjectEditor — no onCommit (immutable column) opens nothing', () => {
  it('a plain click does not activate the editor when onCommit is absent', () => {
    render(<VmadObjectEditor value="000123:Foo.esp [2]" read={READ} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('read placeholder'));
    expect(screen.queryByLabelText('Alias')).not.toBeInTheDocument();
    expect(screen.getByText('read placeholder')).toBeInTheDocument();
  });
});

describe('VmadObjectEditor — active state renders the shared FormKeyCell plus alias', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('parses "FormKey [alias]" into the FormKeyCell label and the alias input value', () => {
    renderInactive('000123:Foo.esp [2]');
    activate();
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(2);
  });

  // Issue #229: this is FormKeyCell's own empty-value placeholder now (matching every ordinary
  // FormKey cell in the grid), not a bespoke hint.
  it("shows FormKeyCell's own placeholder when the FormKey is empty", () => {
    renderInactive('');
    activate();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('VmadObjectEditor — alias edits', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('commits { formKey, alias } on blur after changing the alias', () => {
    const onCommit = vi.fn();
    renderInactive('000123:Foo.esp [2]', onCommit);
    activate();
    const aliasInput = screen.getByLabelText('Alias');
    fireEvent.change(aliasInput, { target: { value: '5' } });
    fireEvent.blur(aliasInput);
    expect(onCommit).toHaveBeenCalledWith({ formKey: '000123:Foo.esp', alias: 5 });
  });

  // Issue #229: the same no-op guard AC1 introduces for scalar leaves, applied to the one leaf
  // VMAD still hand-rolls after this refactor — activating and blurring with no change must not
  // commit a change.
  it('does not commit a change when the alias is blurred with the same value (no-op guard)', () => {
    const onCommit = vi.fn();
    renderInactive('000123:Foo.esp [2]', onCommit);
    activate();
    fireEvent.blur(screen.getByLabelText('Alias'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('resets to the disk value when the value prop changes externally', () => {
    const { rerender } = render(<VmadObjectEditor value="000123:Foo.esp [2]" read={READ} onCommit={vi.fn()} onOpen={vi.fn()} />);
    activate();
    rerender(<VmadObjectEditor value="000456:Bar.esp [9]" read={READ} onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('000456:Bar.esp')).toBeInTheDocument();
    expect(screen.getByLabelText('Alias')).toHaveValue(9);
  });
});

describe('VmadObjectEditor — picking a FormKey', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  // Issue #229: the picker call is FormKeyCell's own — seeded with the current reference and
  // filtered by validFormKeyTypes, same as every other FormKey field. Empty valid-types list:
  // VMAD's Object-kind property Type carries no Papyrus-declared expected class (see
  // VmadObjectEditor.tsx's OBJECT_META comment).
  it('clicking the FormKey cell opens the picker seeded with the current FormKey and no type filter', () => {
    renderInactive('000123:Foo.esp [2]');
    activate();
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    expect(pickFormKey).toHaveBeenCalledWith('000123:Foo.esp', []);
  });

  it('commits { formKey, alias } when pickFormKey resolves with a selection', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('000789:Baz.esp');
    renderInactive('000123:Foo.esp [2]', onCommit);
    activate();
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith({ formKey: '000789:Baz.esp', alias: 2 }));
    expect(screen.getByText('000789:Baz.esp')).toBeInTheDocument();
  });

  it('leaves the field unchanged when pickFormKey resolves null (Escape/blur)', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce(null);
    renderInactive('000123:Foo.esp [2]', onCommit);
    activate();
    fireEvent.click(screen.getByText('000123:Foo.esp'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('000123:Foo.esp')).toBeInTheDocument();
  });
});

describe('VmadObjectEditor — Ctrl+click follows the reference once active', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  // Issue #229: a behavior addition over the old bespoke button, which had no Ctrl+click handling
  // at all once active — composing the shared FormKeyCell brings this for free, consistent with
  // every ordinary FormKey cell in the grid.
  it('Ctrl+click on the active FormKeyCell follows the reference instead of opening the picker', () => {
    const onOpen = vi.fn();
    renderInactive('000123:Foo.esp [2]', vi.fn(), onOpen);
    activate();
    fireEvent.click(screen.getByText('000123:Foo.esp'), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled(); // unresolved by default — no resolution passed
    expect(pickFormKey).not.toHaveBeenCalled();
  });
});
