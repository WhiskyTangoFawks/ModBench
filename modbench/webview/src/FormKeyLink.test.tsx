import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };

describe('FormKeyLink — label is the composite "EditorID [FormKey]", never the EditorID alone, so the format a reference is chosen in and read back in agree', () => {
  it('renders the composite EditorID [FormKey] as its label when resolved (valid type)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]')).toBeInTheDocument();
  });

  it('cuts a label too wide for its column with an ellipsis of its own, as a td\'s ellipsis never clips inside a button\'s text and a flex item\'s min-width: auto would cancel it (happy-dom has no layout: only the declaration is checked)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]').style).toMatchObject({
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', minWidth: '0',
    });
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
