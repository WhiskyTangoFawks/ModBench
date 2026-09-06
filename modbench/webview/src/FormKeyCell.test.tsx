import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// A plain click on an editable cell calls pickFormKey, the native-QuickPick bridge — mocked so
// these cases assert the call rather than rendered picker DOM.
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({ pickFormKey: (...args: unknown[]) => pickFormKey(...args) }));

import { FormKeyCell } from './FormKeyCell';
import type { FormKeyResolution } from './types';
import { fieldMeta } from './test/fixtures';

const fkMeta = fieldMeta({ name: 'Race', type: 'formKey', validFormKeyTypes: ['race'] });

// Navigation requires the leaf's own resolution to say the reference is followable.
const resolvedFixture: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: null };

// One gesture split, uniform across the grid — plain click edits (opens the
// picker), Ctrl+click follows the reference.
describe('FormKeyCell — read-only column', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('shows "—" when value is null', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the formKey string as a link', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('Ctrl+click navigates to the referenced record', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={onOpen} onCommit={vi.fn()} resolution={resolvedFixture} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
  });

  it('plain click neither navigates nor opens the picker', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(pickFormKey).not.toHaveBeenCalled();
  });
});

// ADR-0034: a mutable column's plain click opens the native QuickPick, so selection and Ctrl+V
// are the platform's; an immutable column opens nothing and copies with Ctrl+C.
describe('FormKeyCell — immutable column opens nothing', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };

  it('a plain click opens no input', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DogmeatRace [000019:Fallout4.esm]' })).toBeInTheDocument();
  });

  it('a double click opens no input either', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.doubleClick(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens no input for a reference that does not resolve either', () => {
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // Ctrl+click and plain click share the same DOM click event, so the two must not both fire.
  it('Ctrl+click follows the reference without opening anything', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={onOpen} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // A `cursor: 'pointer'` here would paint over the parent DiskCell's `grab`, and an empty cell
  // is still a drag target.
  it('does not mask the parent drag cursor on an empty cell', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—').style.cursor).not.toBe('pointer');
  });

  it('opens nothing on a null value — the em-dash is a placeholder', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // The warning icon is the cell's, not the link's — clicking must not hide it.
  it('keeps the checkError icon visible', () => {
    render(
      <FormKeyCell
        value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false}
        onOpen={vi.fn()} onCommit={vi.fn()} checkError="dangling reference" resolution={validType}
      />,
    );
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });
});

describe('FormKeyCell — editable column', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('shows "—" when value is null, not a picker button', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('shows the current formKey as a link at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('plain click on an empty cell opens the picker with an empty seed', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(pickFormKey).toHaveBeenCalledWith('', ['race']);
  });

  // Seeded with the current reference — the picker needs to know what it's replacing.
  it('plain click on a cell with a value opens the picker, not navigation', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={true} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('commits the picked FormKey when pickFormKey resolves with a selection', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('00001A:Fallout4.esm');
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('—'));
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith('00001A:Fallout4.esm'));
  });

  it('leaves the field unchanged when pickFormKey resolves null (Escape/blur)', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce(null);
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The picker's input is a mutable column's only surface for copying the value, so a bare
  // FormKey seed would leave the one editable column unable to hand over what it displays.
  it('seeds the picker with the composite label the cell displays', () => {
    const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(pickFormKey).toHaveBeenCalledWith('DogmeatRace [000019:Fallout4.esm]', ['race']);
  });

  it('Ctrl+click navigates instead of opening the picker', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={true} onOpen={onOpen} onCommit={vi.fn()} resolution={resolvedFixture} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
    expect(pickFormKey).not.toHaveBeenCalled();
  });
});

// ADR-0034: same open-gate as ScalarCell/FlagCell — second click on the
// already-focused cell, F2 (via DiskCell's data-open-trigger dispatch), or a double click.
describe('FormKeyCell — mutable column gates opening on the focus check', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('a click on a cell with a value, while not the focused cell, does not open the picker', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('a click on an empty cell, while not the focused cell, does not open the picker', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('a double click opens the picker even when not the focused cell', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('a double click on an empty cell opens the picker even when not the focused cell', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('—'));
    expect(pickFormKey).toHaveBeenCalledWith('', ['race']);
  });

  it('marks the mutable link as the open trigger', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm').closest('[data-open-trigger]')).not.toBeNull();
  });

  it('does not mark the immutable link as an open trigger', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm').closest('[data-open-trigger]')).toBeNull();
  });
});

// The link affordance appears on Ctrl-hover only, and only where the reference goes somewhere:
// advertised on a dangling reference it lies. Mirrors xEdit's vstViewCheckHotTrack, which sets
// Allow := Assigned(lLinksTo) and requires VK_CONTROL.
describe('FormKeyCell — Ctrl-hover link affordance', () => {
  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('shows no link affordance at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    expect(link.style.textDecoration).toBe('none');
  });

  it('shows the link affordance when Ctrl is held and the cell is hovered', () => {
    const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: null };
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} resolution={validType} />);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
  });

  it('shows no link affordance on Ctrl-hover when the reference does not resolve', () => {
    const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} resolution={unresolved} />);
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });

  // The affordance and the gesture agree: a link that does not look followable is not
  // followable. Otherwise Ctrl+click would navigate to a record that is not in the index.
  it('Ctrl+click does not navigate when the reference does not resolve', () => {
    const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };
    const onOpen = vi.fn();
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={onOpen} onCommit={vi.fn()} resolution={unresolved} />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drops the affordance again when Ctrl is released', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    fireEvent.keyUp(window, { key: 'Control' });
    expect(link.style.textDecoration).toBe('none');
  });
});

// ADR-0031: the affordance and label key off the leaf's own resolution signal — checkError
// drives the warning icon but never gates the link.
describe('FormKeyCell — resolution-driven label and affordance', () => {
  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
  const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

  // The composite, not the bare EditorID: the path the grid's generic FormKey fields take.
  it('labels the link with the resolved EditorID [FormKey] composite', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]')).toBeInTheDocument();
  });

  it('shows the affordance for a resolved-wrong-type reference even though it carries a checkError', () => {
    render(
      <FormKeyCell
        value="00001A:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false}
        onOpen={vi.fn()} onCommit={vi.fn()}
        checkError="[00001A:Fallout4.esm] <Warning: resolves to unexpected type>"
        resolution={wrongType}
      />,
    );
    const link = screen.getByText('SomeNpc [00001A:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });

  it('suppresses the affordance when unresolved, even with no checkError present', () => {
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} resolution={unresolved} />);
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });
});

describe('FormKeyCell — checkError', () => {
  it('shows no warning icon when checkError is absent', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('shows a warning icon with the checkError as its title in view mode', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} isFocused={false} onOpen={vi.fn()} onCommit={vi.fn()} checkError="dangling reference" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });

  it('shows a warning icon in edit mode too', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} isFocused={true} onOpen={vi.fn()} onCommit={vi.fn()} checkError="null not allowed" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'null not allowed');
  });
});
