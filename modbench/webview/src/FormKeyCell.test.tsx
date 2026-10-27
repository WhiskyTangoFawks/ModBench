import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const pickFormKey = vi.fn<(seed: string, validTypes: string[]) => Promise<string | null>>().mockResolvedValue(null);
vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { FormKeyCell } from './FormKeyCell';
import type { FormKeyResolution } from './types';
import { fieldMeta, hostPicking } from './test/fixtures';
import { vscode } from './vscode';

vi.mocked(vscode.postMessage).mockImplementation(hostPicking((seed, validTypes) => pickFormKey(seed, validTypes)));

const fkMeta = fieldMeta({ name: 'Race', type: 'formKey', validFormKeyTypes: ['race'] });

const followableResolutionFixture: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: null };

describe('FormKeyCell — a read-only column opens nothing, leaving copy to Ctrl+C', () => {
  afterEach(() => { pickFormKey.mockClear(); });
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };

  it('shows "—" when value is null', () => {
    render(<FormKeyCell value={null} meta={fkMeta} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the formKey string as a link', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('plain click does not open the picker', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('opens no picker from a click on the placeholder of a null value', () => {
    render(<FormKeyCell value={null} meta={fkMeta} />);
    fireEvent.click(screen.getByText('—'));
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('keeps the checkError icon, the cell\'s own rather than the link\'s, visible when clicked', () => {
    render(
      <FormKeyCell
        value="000019:Fallout4.esm" meta={fkMeta}
        checkError="dangling reference" resolution={validType}
      />,
    );
    fireEvent.click(screen.getByText('DogmeatRace'));
    expect(screen.getByRole('img', { name: 'warning' })).toHaveAttribute('title', 'dangling reference');
  });
});

describe('FormKeyCell — editable column, whose plain click opens the native QuickPick so selection and Ctrl+V are the platform\'s', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('shows no pointer on an empty cell', () => {
    render(<FormKeyCell value={null} meta={fkMeta} onCommit={vi.fn()} />);
    expect(screen.getByText('—').style.cursor).not.toBe('pointer');
  });

  it('plain click on an empty cell opens the picker with an empty seed', () => {
    render(<FormKeyCell value={null} meta={fkMeta} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(pickFormKey).toHaveBeenCalledWith('', ['race']);
  });

  it('plain click on a cell with a value opens the picker seeded with the reference it replaces', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('commits the picked FormKey when pickFormKey resolves with a selection', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('00001A:Fallout4.esm');
    render(<FormKeyCell value={null} meta={fkMeta} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('—'));
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith('00001A:Fallout4.esm'));
  });

  it('leaves the field unchanged when pickFormKey resolves null (Escape/blur)', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce(null);
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits nothing when the picked FormKey is the one the cell already holds', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('000019:Fallout4.esm');
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    await Promise.resolve();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('seeds the picker with the composite label the cell displays, as the picker\'s input is a mutable column\'s only surface for copying it', () => {
    const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace'));
    expect(pickFormKey).toHaveBeenCalledWith('DogmeatRace [000019:Fallout4.esm]', ['race']);
  });

  it('Ctrl+click opens no picker: go to record is the menu\'s', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={vi.fn()} resolution={followableResolutionFixture} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(pickFormKey).not.toHaveBeenCalled();
  });
});

describe('FormKeyCell — one gesture opens one picker', () => {
  afterEach(() => { pickFormKey.mockReset().mockResolvedValue(null); });

  it('two open gestures while the picker is open leave a single picker', () => {
    pickFormKey.mockReturnValue(new Promise(() => undefined));
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');

    fireEvent.click(link);
    fireEvent.click(link);

    expect(pickFormKey).toHaveBeenCalledTimes(1);
  });

  it('opens the picker again once the first has closed', async () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');

    fireEvent.click(link);
    await vi.waitFor(() => { fireEvent.click(link); expect(pickFormKey).toHaveBeenCalledTimes(2); });
  });
});
