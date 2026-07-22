import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

// Issue #157 / ADR-0031: the link now labels itself from the resolution signal instead of always
// echoing the raw FormKey — a resolved reference reads as the record it points to.
describe('FormKeyLink — label', () => {
  it('renders the EditorID as its label when resolved (valid type)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onOpen={vi.fn()} />);
    expect(screen.getByText('DogmeatRace')).toBeInTheDocument();
    expect(screen.queryByText('000019:Fallout4.esm')).not.toBeInTheDocument();
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

// Issue #157: the affordance now keys off the tri-state signal directly — resolved-wrong-type
// gets it too (xEdit allows the jump), only Unresolved withholds it.
describe('FormKeyLink — Ctrl-hover affordance from resolution', () => {
  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('shows the affordance for a resolved-valid-type reference', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onOpen={vi.fn()} />);
    const link = screen.getByText('DogmeatRace');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
  });

  it('shows the affordance for a resolved-wrong-type reference', () => {
    render(<FormKeyLink value="00001A:Fallout4.esm" resolution={wrongType} onOpen={vi.fn()} />);
    const link = screen.getByText('SomeNpc');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
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
    fireEvent.click(screen.getByText('SomeNpc'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('00001A:Fallout4.esm');
  });

  it('Ctrl+click does not follow an unresolved reference', () => {
    const onOpen = vi.fn();
    render(<FormKeyLink value="FFFFFF:Dangling.esm" resolution={unresolved} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
