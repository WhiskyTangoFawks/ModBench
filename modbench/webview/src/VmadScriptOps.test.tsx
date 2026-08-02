import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./addScriptBridge', () => ({ pickScriptName: vi.fn() }));

import { AddScriptButton, RemoveScriptButton, ScriptFlagsControl } from './VmadScriptOps';
import { pickScriptName } from './addScriptBridge';

// Issue #212: the add-script dialog (ModalShell + name/flags fields) was deleted — "Add script"
// is now a native input box (pickScriptName, webview/src/addScriptBridge.ts) collecting one
// field, a name. Flags are no longer chosen at creation time (new scripts always start 'Local',
// per the issue's explicit "one field, a name"); ScriptFlagsControl below remains the only way
// to change a script's flags, same as it already was for every script after its first add.
describe('AddScriptButton', () => {
  beforeEach(() => { vi.mocked(pickScriptName).mockReset(); });

  it('clicking + script opens the native input box via pickScriptName', () => {
    vi.mocked(pickScriptName).mockResolvedValue(null);
    render(<AddScriptButton plugin="A.esm" onStructOp={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Add script'));
    expect(pickScriptName).toHaveBeenCalled();
  });

  it('a picked name stages an add_script op scoped to the plugin, defaulting flags to Local', async () => {
    const onStructOp = vi.fn();
    vi.mocked(pickScriptName).mockResolvedValue('MyScript');
    render(<AddScriptButton plugin="A.esm" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Add script'));

    await waitFor(() => expect(onStructOp).toHaveBeenCalledWith(
      'A.esm',
      String.raw`VMAD\MyScript`,
      { op: 'add_script', name: 'MyScript', flags: 'Local', properties: [] },
    ));
  });

  it('a dismissed pick (null, empty/whitespace already rejected natively) stages nothing', async () => {
    const onStructOp = vi.fn();
    vi.mocked(pickScriptName).mockResolvedValue(null);
    render(<AddScriptButton plugin="A.esm" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Add script'));

    await waitFor(() => expect(pickScriptName).toHaveBeenCalled());
    expect(onStructOp).not.toHaveBeenCalled();
  });
});

describe('RemoveScriptButton', () => {
  it('stages a remove_script op for the plugin/script', () => {
    const onStructOp = vi.fn();
    render(<RemoveScriptButton plugin="A.esm" scriptName="S" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Remove script'));
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S`, { op: 'remove_script' });
  });
});

describe('ScriptFlagsControl', () => {
  it('reflects the current flag', () => {
    render(<ScriptFlagsControl plugin="A.esm" scriptName="S" current="Inherited" onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Flags for S')).toHaveValue('Inherited');
  });

  it('defaults to Local when there is no current flag', () => {
    render(<ScriptFlagsControl plugin="A.esm" scriptName="S" current={null} onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Flags for S')).toHaveValue('Local');
  });

  it('changing the selection stages a set_flags op', () => {
    const onStructOp = vi.fn();
    render(<ScriptFlagsControl plugin="A.esm" scriptName="S" current="Local" onStructOp={onStructOp} />);
    fireEvent.change(screen.getByLabelText('Flags for S'), { target: { value: 'Inherited' } });
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S`, { op: 'set_flags', flags: 'Inherited' });
  });
});
