import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { FormKeyCell } from './FormKeyCell';
import type { FieldMetadata } from './types';
import type { RecordSessionClient } from './RecordSessionClient';

// Issue #122: the panel talks to the backend only through an injected client. A client whose
// picker search is stubbed is enough for the FormKeyCell unit tests, which never open the
// picker (they assert link / navigation gestures, not search results).
const stubClient = { searchRecords: vi.fn().mockResolvedValue([]) } as unknown as RecordSessionClient;

const fkMeta: FieldMetadata = {
  name: 'Race', type: 'formKey', isArray: false, validFormKeyTypes: ['race'], enumValues: [],
};

// Issue #111: one gesture split, uniform across the grid — plain click edits (opens the
// picker), Ctrl+click follows the reference. This is the collision the mode was silently
// resolving: click used to mean "navigate" in view mode and "open picker" in edit mode.
describe('FormKeyCell — read-only column', () => {
  it('shows "—" when value is null', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the formKey string as a link', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('Ctrl+click navigates to the referenced record', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
  });

  it('plain click does nothing — no navigation, no picker', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Search EditorID…')).not.toBeInTheDocument();
  });
});

describe('FormKeyCell — editable column', () => {
  it('shows "—" when value is null, not a picker button', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search EditorID…')).not.toBeInTheDocument();
  });

  it('shows the current formKey as a link at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('plain click opens the FormKey picker inline', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
  });

  it('plain click on a cell with a value opens the picker, not navigation', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Ctrl+click navigates instead of opening the picker', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
    expect(screen.queryByPlaceholderText('Search EditorID…')).not.toBeInTheDocument();
  });
});

// Issue #111: the link affordance appears on Ctrl-hover only, and only where the reference
// actually goes somewhere — without the guard the gesture is invisible, and with it advertised
// on a dangling reference it lies. Mirrors xEdit's vstViewCheckHotTrack, which sets
// Allow := Assigned(lLinksTo) and requires VK_CONTROL.
//
// The resolve guard is checkError: the backend emits one ("<Error: Could not be resolved>")
// exactly when a FormLink is not in the record index, and it is already threaded to the cell.
// It is a proxy, not the real thing — see #141 and the note in medit-record-editor.md.
describe('FormKeyCell — Ctrl-hover link affordance', () => {
  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('shows no link affordance at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    expect(link.style.textDecoration).toBe('none');
  });

  it('shows the link affordance when Ctrl is held and the cell is hovered', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
  });

  it('shows no link affordance on Ctrl-hover when the reference does not resolve', () => {
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} checkError="[FFFFFF:Dangling.esm] <Error: Could not be resolved>" />);
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });

  // The affordance and the gesture agree: a link that does not look followable is not
  // followable. Otherwise Ctrl+click would navigate to a record that is not in the index.
  it('Ctrl+click does not navigate when the reference does not resolve', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} checkError="[FFFFFF:Dangling.esm] <Error: Could not be resolved>" />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drops the affordance again when Ctrl is released', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    fireEvent.keyUp(window, { key: 'Control' });
    expect(link.style.textDecoration).toBe('none');
  });
});

describe('FormKeyCell — checkError', () => {
  it('shows no warning icon when checkError is absent', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('shows a warning icon with the checkError as its title in view mode', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} checkError="dangling reference" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });

  it('shows a warning icon in edit mode too', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} checkError="null not allowed" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'null not allowed');
  });
});
