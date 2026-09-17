import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

// ADR-0005: the label is the composite "EditorID [FormKey]", never the EditorID alone — the
// format a reference is chosen in and the format it is read back in must agree.
describe('FormKeyLink — label', () => {
  it('renders the composite EditorID [FormKey] as its label when resolved (valid type)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onOpen={vi.fn()} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]')).toBeInTheDocument();
  });

  // The <td>'s own ellipsis clips at the boundary of an atomic inline box, never inside a
  // <button>'s text, so the link carries the ellipsis itself. happy-dom has no layout: this
  // proves only the declaration is present.
  it('declares its own ellipsis truncation rather than relying on the cell to clip it', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onOpen={vi.fn()} />);
    const link = screen.getByText('DogmeatRace [000019:Fallout4.esm]');
    expect(link.style.overflow).toBe('hidden');
    expect(link.style.textOverflow).toBe('ellipsis');
    expect(link.style.whiteSpace).toBe('nowrap');
    expect(link.style.maxWidth).toBe('100%');
    // FormKeyCell wraps this in an `inline-flex` span, and a flex item's default
    // `min-width: auto` refuses to shrink below its content, cancelling the ellipsis above.
    expect(link.style.minWidth).toBe('0');
  });

  it('renders the plain FormKey string when unresolved', () => {
    render(<FormKeyLink value="FFFFFF:Dangling.esm" resolution={unresolved} onOpen={vi.fn()} />);
    expect(screen.getByText('FFFFFF:Dangling.esm')).toBeInTheDocument();
  });

  it('renders the plain FormKey string when no resolution prop is supplied (safe default)', () => {
    render(<FormKeyLink value="FFFFFF:Dangling.esm" onOpen={vi.fn()} />);
    expect(screen.getByText('FFFFFF:Dangling.esm')).toBeInTheDocument();
  });
});

// The affordance keys off the tri-state signal directly — resolved-wrong-type
// gets it too (xEdit allows the jump), only Unresolved withholds it.
describe('FormKeyLink — Ctrl-hover affordance from resolution', () => {
  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('shows the affordance for a resolved-valid-type reference', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onOpen={vi.fn()} />);
    const link = screen.getByText('DogmeatRace [000019:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
  });

  it('shows the affordance for a resolved-wrong-type reference', () => {
    render(<FormKeyLink value="00001A:Fallout4.esm" resolution={wrongType} onOpen={vi.fn()} />);
    const link = screen.getByText('SomeNpc [00001A:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
  });

  // ADR-0018: DiskCell sets `grab` on the parent <td> and the cell is a drag source throughout,
  // so an inline `cursor: 'default'` here would paint an arrow over the one gesture always
  // available on the cell.
  it('does not mask the parent drag cursor with its own cursor style at rest', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onOpen={vi.fn()} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]').style.cursor).toBe('');
  });

  it('suppresses the affordance for an unresolved reference', () => {
    render(<FormKeyLink value="FFFFFF:Dangling.esm" resolution={unresolved} onOpen={vi.fn()} />);
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });

  it('Ctrl+click follows a resolved-wrong-type reference', () => {
    const onOpen = vi.fn();
    render(<FormKeyLink value="00001A:Fallout4.esm" resolution={wrongType} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('SomeNpc [00001A:Fallout4.esm]'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('00001A:Fallout4.esm');
  });

  it('Ctrl+click does not follow an unresolved reference', () => {
    const onOpen = vi.fn();
    render(<FormKeyLink value="FFFFFF:Dangling.esm" resolution={unresolved} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
