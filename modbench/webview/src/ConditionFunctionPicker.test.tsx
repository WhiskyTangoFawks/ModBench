import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ConditionFunctionPicker } from './ConditionFunctionPicker';
import type { RecordSessionClient } from './RecordSessionClient';

function makeClient(names: string[]): RecordSessionClient {
  return { conditionFunctions: vi.fn().mockResolvedValue(names) } as unknown as RecordSessionClient;
}

describe('ConditionFunctionPicker', () => {
  it('shows the current function as a button', () => {
    render(<ConditionFunctionPicker value="GetIsID" client={makeClient([])} onCommit={vi.fn()} />);
    expect(screen.getByText('GetIsID')).toBeInTheDocument();
  });

  it('opens a searchable list on click and filters by substring', async () => {
    const client = makeClient(['GetIsID', 'GetDistance', 'GetStageDone']);
    render(<ConditionFunctionPicker value="GetIsID" client={client} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByText('GetIsID'));
    const input = await screen.findByPlaceholderText('Search function…');
    fireEvent.change(input, { target: { value: 'Dist' } });

    await waitFor(() => expect(screen.getByText('GetDistance')).toBeInTheDocument());
    expect(screen.queryByText('GetStageDone')).toBeNull();
  });

  it('commits the selected function and closes the picker', async () => {
    const client = makeClient(['GetIsID', 'GetDistance']);
    const onCommit = vi.fn();
    render(<ConditionFunctionPicker value="GetIsID" client={client} onCommit={onCommit} />);

    fireEvent.click(screen.getByText('GetIsID'));
    const input = await screen.findByPlaceholderText('Search function…');
    fireEvent.change(input, { target: { value: 'Distance' } });
    await waitFor(() => expect(screen.getByText('GetDistance')).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText('GetDistance'));

    expect(onCommit).toHaveBeenCalledWith('GetDistance');
  });
});
