import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

// ADR-0005: the label is the composite "EditorID [FormKey]", never the EditorID alone — the
// format a reference is chosen in and the format it is read back in must agree.
describe('FormKeyLink — label', () => {
  it('renders the composite EditorID [FormKey] as its label when resolved (valid type)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]')).toBeInTheDocument();
  });

  // The <td>'s own ellipsis clips at the boundary of an atomic inline box, never inside a
  // <button>'s text, so the link carries the ellipsis itself. happy-dom has no layout: this
  // proves only the declaration is present.
  it('declares its own ellipsis truncation rather than relying on the cell to clip it', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
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
    render(<FormKeyLink value="FFFFFF:Dangling.esm" resolution={unresolved} />);
    expect(screen.getByText('FFFFFF:Dangling.esm')).toBeInTheDocument();
  });

  it('renders the plain FormKey string when no resolution prop is supplied (safe default)', () => {
    render(<FormKeyLink value="FFFFFF:Dangling.esm" />);
    expect(screen.getByText('FFFFFF:Dangling.esm')).toBeInTheDocument();
  });
});

// Go to record is the context menu's: the link carries no gesture of its own for Ctrl.
describe('FormKeyLink — clicks', () => {
  it('a plain click is the caller\'s', () => {
    const onClick = vi.fn();
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onClick={onClick} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('a Ctrl+click is nobody\'s', () => {
    const onClick = vi.fn();
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onClick={onClick} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'), { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('sets no cursor of its own', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]').style.cursor).toBe('');
  });
});
