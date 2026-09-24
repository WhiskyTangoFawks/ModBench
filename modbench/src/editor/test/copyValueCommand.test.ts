import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from '../../test/vscodeMock';

const { registerCommand, writeText } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  writeText: vi.fn<(value: string) => unknown>(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  env: { clipboard: { writeText } },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
}));

import { registerCopyValueCommand, type CopyValueCommandDeps } from '../copyValueCommand';
import { ReferencedByGroupNode } from '../ReferencedByTreeProvider';
import { ModNode, SeparatorNode } from '../../mods/ModListProvider';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';
import { referenceResultFixture } from '../../client/test/fixtures';

function invokeCommand(...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.record.copyValue');
  if (!call) throw new Error('modbench.record.copyValue was not registered');
  return Promise.resolve(call[1](...args));
}

function makeDeps(over: Partial<CopyValueCommandDeps> = {}): CopyValueCommandDeps {
  return {
    referencedByTreeView: { selection: [] },
    modsCopyValueText: () => undefined,
    reporterFor: () => recordingReporter(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCopyValueCommand: the one command id every surface reaches', () => {
  it('registers exactly one command under the catalog id', () => {
    registerCopyValueCommand(makeDeps());
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toBe('modbench.record.copyValue');
  });

  it('writes a Mods row\'s text when the clicked row is a mod or separator', async () => {
    const modsCopyValueText = vi.fn(() => 'Alpha\nGroup A');
    registerCopyValueCommand(makeDeps({ modsCopyValueText }));
    const clicked = new ModNode({ kind: 'mod', name: 'Alpha', enabled: true });
    const allSelected = [clicked];

    await invokeCommand(clicked, allSelected);

    expect(modsCopyValueText).toHaveBeenCalledWith(clicked, allSelected);
    expect(writeText).toHaveBeenCalledWith('Alpha\nGroup A');
  });

  // The rival: dispatching by trying Referenced By first would copy nothing for a Mods row,
  // since referencedByCopyText only recognizes ReferencedByGroupNode.
  it('falls back to Referenced By\'s own text when the row is not a Mods row', async () => {
    const group = new ReferencedByGroupNode('Fallout4.esm:000001', [referenceResultFixture({ formKey: 'Fallout4.esm:000001' })]);
    registerCopyValueCommand(makeDeps({ modsCopyValueText: () => undefined }));

    await invokeCommand(group, [group]);

    expect(writeText).toHaveBeenCalledWith(group.displayLabel);
  });

  it('falls back to the Referenced By tree\'s own selection when invoked with no arguments', async () => {
    const group = new ReferencedByGroupNode('Fallout4.esm:000001', [referenceResultFixture({ formKey: 'Fallout4.esm:000001' })]);
    const referencedByTreeView: CopyValueCommandDeps['referencedByTreeView'] = { selection: [group] };
    registerCopyValueCommand(makeDeps({ referencedByTreeView, modsCopyValueText: () => undefined }));

    await invokeCommand();

    expect(writeText).toHaveBeenCalledWith(group.displayLabel);
  });

  it('writes nothing, and reports nothing, when there is no text to copy', async () => {
    registerCopyValueCommand(makeDeps({ modsCopyValueText: () => undefined }));

    await invokeCommand(undefined, undefined);

    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports why a failed clipboard write failed, for a Mods row', async () => {
    writeText.mockRejectedValueOnce(new Error('no clipboard'));
    let reporter: RecordingReporter | undefined;
    const reporterFor = vi.fn((_tag: string) => { reporter = recordingReporter(); return reporter; });
    const clicked = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
    registerCopyValueCommand(makeDeps({ modsCopyValueText: () => 'Group A', reporterFor }));

    await invokeCommand(clicked, [clicked]);

    expect(reporter?.reports).toEqual([
      { severity: 'error', message: 'Could not copy to the clipboard.', detail: 'no clipboard' },
    ]);
  });

  it('reports why a failed clipboard write failed, for Referenced By, unchanged from before', async () => {
    writeText.mockRejectedValueOnce(new Error('no clipboard'));
    let reporter: RecordingReporter | undefined;
    const reporterFor = vi.fn((_tag: string) => { reporter = recordingReporter(); return reporter; });
    const group = new ReferencedByGroupNode('Fallout4.esm:000001', [referenceResultFixture({ formKey: 'Fallout4.esm:000001' })]);
    registerCopyValueCommand(makeDeps({ modsCopyValueText: () => undefined, reporterFor }));

    await invokeCommand(group, [group]);

    expect(reporter?.reports).toEqual([
      { severity: 'error', message: 'Could not copy to the clipboard.', detail: 'no clipboard' },
    ]);
  });
});
