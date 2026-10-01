import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// A plain click on an editable cell calls pickFormKey, the native-QuickPick bridge — mocked so
// these cases assert the call rather than rendered picker DOM.
const pickFormKey = vi.fn<(seed: string, validTypes: string[]) => Promise<string | null>>().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({ pickFormKey: (seed: string, validTypes: string[]) => pickFormKey(seed, validTypes) }));

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
    render(<FormKeyCell value={null} meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the formKey string as a link', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('plain click does not open the picker', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).not.toHaveBeenCalled();
  });
});

// ADR-0018: a mutable column's plain click opens the native QuickPick, so selection and Ctrl+V
// are the platform's; an immutable column opens nothing and copies with Ctrl+C.
describe('FormKeyCell — immutable column opens nothing', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };

  it('a plain click opens no input', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DogmeatRace [000019:Fallout4.esm]' })).toBeInTheDocument();
  });

  it('a double click opens no input either', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens no input for a reference that does not resolve either', () => {
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows no pointer on an empty cell', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    expect(screen.getByText('—').style.cursor).not.toBe('pointer');
  });

  it('opens nothing on a null value — the em-dash is a placeholder', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // The warning icon is the cell's, not the link's — clicking must not hide it.
  it('keeps the checkError icon visible', () => {
    render(
      <FormKeyCell
        value="000019:Fallout4.esm" meta={fkMeta} editable={false}
        onCommit={vi.fn()} checkError="dangling reference" resolution={validType}
      />,
    );
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });
});

describe('FormKeyCell — editable column', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('shows "—" when value is null, not a picker button', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('shows the current formKey as a link at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('plain click on an empty cell opens the picker with an empty seed', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(pickFormKey).toHaveBeenCalledWith('', ['race']);
  });

  // Seeded with the current reference — the picker needs to know what it's replacing.
  it('plain click on a cell with a value opens the picker', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('commits the picked FormKey when pickFormKey resolves with a selection', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('00001A:Fallout4.esm');
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('—'));
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith('00001A:Fallout4.esm'));
  });

  it('leaves the field unchanged when pickFormKey resolves null (Escape/blur)', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce(null);
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits nothing when the picked FormKey is the one the cell already holds', async () => {
    const onCommit = vi.fn();
    pickFormKey.mockResolvedValueOnce('000019:Fallout4.esm');
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    await vi.waitFor(() => expect(pickFormKey).toHaveBeenCalled());
    await Promise.resolve();
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The picker's input is a mutable column's only surface for copying the value, so a bare
  // FormKey seed would leave the one editable column unable to hand over what it displays.
  it('seeds the picker with the composite label the cell displays', () => {
    const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={vi.fn()} resolution={validType} />);
    fireEvent.click(screen.getByText('DogmeatRace [000019:Fallout4.esm]'));
    expect(pickFormKey).toHaveBeenCalledWith('DogmeatRace [000019:Fallout4.esm]', ['race']);
  });

  it('Ctrl+click opens no picker: go to record is the menu\'s', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={vi.fn()} resolution={resolvedFixture} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(pickFormKey).not.toHaveBeenCalled();
  });
});

// ADR-0018: same open-gate as ScalarCell/FlagCell — second click on the
// already-focused cell, F2 (via DiskCell's data-open-trigger dispatch), or a double click.
describe('FormKeyCell — mutable column gates opening on the focus check', () => {
  afterEach(() => { pickFormKey.mockClear(); });

  it('the open trigger opens the picker on a cell with a value', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('the open trigger opens the picker on an empty cell', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(pickFormKey).toHaveBeenCalledWith('', ['race']);
  });

  it('marks the mutable link as the open trigger', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm').closest('[data-open-trigger]')).not.toBeNull();
  });

  it('does not mark the immutable link as an open trigger', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm').closest('[data-open-trigger]')).toBeNull();
  });
});

// ADR-0005: the label keys off the leaf's own resolution signal.
describe('FormKeyCell — resolution-driven label', () => {
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'race', editorId: 'DogmeatRace' };

  // The composite, not the bare EditorID: the path the grid's generic FormKey fields take.
  it('labels the link with the resolved EditorID [FormKey] composite', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} resolution={validType} />);
    expect(screen.getByText('DogmeatRace [000019:Fallout4.esm]')).toBeInTheDocument();
  });
});

describe('FormKeyCell — checkError', () => {
  it('shows no warning icon when checkError is absent', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('shows a warning icon with the checkError as its title in view mode', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} onCommit={vi.fn()} checkError="dangling reference" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });

  it('shows a warning icon in edit mode too', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} onCommit={vi.fn()} checkError="null not allowed" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'null not allowed');
  });
});

describe('FormKeyCell — one gesture opens one picker', () => {
  afterEach(() => { pickFormKey.mockReset().mockResolvedValue(null); });

  it('two open gestures while the picker is open leave a single picker', () => {
    pickFormKey.mockReturnValue(new Promise(() => undefined));
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');

    fireEvent.click(link);
    fireEvent.click(link);

    expect(pickFormKey).toHaveBeenCalledTimes(1);
  });

  it('opens the picker again once the first has closed', async () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');

    fireEvent.click(link);
    await vi.waitFor(() => { fireEvent.click(link); expect(pickFormKey).toHaveBeenCalledTimes(2); });
  });
});
