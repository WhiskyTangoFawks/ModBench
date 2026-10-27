import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { FormKeyLink } from './FormKeyLink';
import type { FormKeyResolution } from './types';

const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };

describe('FormKeyLink — the cell reads the EditorID, with the composite in its tooltip', () => {
  it('renders the EditorID as its label, and the composite EditorID [FormKey] as its tooltip, when resolved', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace')).toHaveAttribute('title', 'DogmeatRace [000019:Fallout4.esm]');
  });

  it('renders the FormKey when the record has no EditorID', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={{ ...validType, editorId: null }} />);
    expect(screen.getByText('000019:Fallout4.esm')).toHaveAttribute('title', '000019:Fallout4.esm');
  });

  it('holds the warning reason in its tooltip beside the composite', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} checkError="wrong type" />);
    expect(screen.getByText('DogmeatRace')).toHaveAttribute('title', 'DogmeatRace [000019:Fallout4.esm]\nwrong type');
  });

  it('cuts a label too wide for its column with an ellipsis of its own, as a td\'s ellipsis never clips inside a button\'s text and a flex item\'s min-width: auto would cancel it (happy-dom has no layout: only the declaration is checked)', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace').style).toMatchObject({
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', minWidth: '0',
    });
  });
});

describe('FormKeyLink — clicks, where go to record is the context menu\'s and the link carries no gesture of its own for Ctrl', () => {
  it('a plain click is the caller\'s', () => {
    const onClick = vi.fn();
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onClick={onClick} />);
    fireEvent.click(screen.getByText('DogmeatRace'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('a Ctrl+click is nobody\'s', () => {
    const onClick = vi.fn();
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} onClick={onClick} />);
    fireEvent.click(screen.getByText('DogmeatRace'), { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('sets no cursor of its own', () => {
    render(<FormKeyLink value="000019:Fallout4.esm" resolution={validType} />);
    expect(screen.getByText('DogmeatRace').style.cursor).toBe('');
  });
});
