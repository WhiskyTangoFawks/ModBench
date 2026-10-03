import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

describe('FormKeyLink — label is the composite "EditorID [FormKey]", never the EditorID alone, so the format a reference is chosen in and read back in agree', () => {
  it('renders the composite EditorID [FormKey] as its label when resolved (valid type)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]')).toBeInTheDocument();
  });

  it('declares its own ellipsis truncation rather than relying on the cell to clip it, as a td\'s ellipsis never clips inside a button\'s text (happy-dom has no layout: only the declaration is checked)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    const link = screen.getByText('DogmeatRace [000019:Fallout4.esm]');
    expect(link.style.overflow).toBe('hidden');
    expect(link.style.textOverflow).toBe('ellipsis');
    expect(link.style.whiteSpace).toBe('nowrap');
    expect(link.style.maxWidth).toBe('100%');
  });

  it('declares min-width 0 so it can shrink inside FormKeyCell\'s inline-flex span, whose flex item default min-width: auto would cancel the ellipsis', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]').style.minWidth).toBe('0');
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

describe('FormKeyLink — clicks, where go to record is the context menu\'s and the link carries no gesture of its own for Ctrl', () => {
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
