import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, handlers } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
}));
vi.mock('vscode', async () => ({
  TreeItem: (await import('./vscodeMock')).TreeItem,
  TreeItemCollapsibleState: (await import('./vscodeMock')).TreeItemCollapsibleState,
  window: { showErrorMessage },
  commands: { registerCommand: (id: string, handler: (...args: unknown[]) => Promise<void>) => { handlers.set(id, handler); return { dispose: () => {} }; } },
}));

import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import { makeReporter } from '../reporter';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { applyRecordEdit } from '../editor/applyRecordEdit';
import { registerRecordLifecycleCommands } from '../editor/recordLifecycleCommands';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { present } from '../ports/present';
import type { RecordEditEnvelope } from '../wire/messages';

const EDIT: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'EditorID' }], value: 'X' };

const ACCEPT = 'Delete';

async function offerTwice(dialog: ReturnType<typeof scriptedDialog>): Promise<boolean[]> {
  const client = new InMemoryMEditClient();
  client.setCommandResult('deleteRecords', { landed: [], refused: [] });
  registerRecordLifecycleCommands(client, recordingReporter(), dialog, () => [], (command) => command());
  const deleteRecord = present(handlers.get('modbench.record.delete'), 'the record delete handler');
  const offer = async (plugin: string) => {
    const before = client.calls.length;
    await deleteRecord({ formKey: `000800:${plugin}`, plugin, origin: 'ModA' });
    return client.calls.length > before;
  };
  return [await offer('A.esp'), await offer('B.esp')];
}

describe('the recording reporter', () => {
  it('records the severity, message and detail a module reported, in order', async () => {
    const reporter = recordingReporter();
    const meditClient = { editRecord: () => Promise.reject(new Error('backend down')) };

    await applyRecordEdit({ meditClient, refreshSourceControlFor: () => {}, reporter }, '000800', { name: 'A.esp', origin: 'ModA' }, EDIT);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not edit EditorID.', detail: 'backend down' },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('records a refusal as a warning with no detail, and a landing separately from a report', async () => {
    const reporter = recordingReporter();
    const meditClient = { editRecord: () => Promise.resolve({ applied: false as const, refusal: 'ReadOnly', message: 'Record is read-only.' }) };

    await applyRecordEdit({ meditClient, refreshSourceControlFor: () => {}, reporter }, '000800', { name: 'A.esp', origin: 'ModA' }, EDIT);
    reporter.landed('Mods deployed.');

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'EditorID: Record is read-only.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual(['Mods deployed.']);
  });
});

describe('the recording reporter, given a selection\'s outcome', () => {
  beforeEach(() => { showErrorMessage.mockClear(); });

  interface PluginAddress { origin: string; filename: string }
  const nameOf = (p: PluginAddress) => `${p.origin}/${p.filename}`;
  const MESSAGE = 'Could not delete 1 record.';
  const FULLY_LANDED: SelectionOutcome<PluginAddress> = {
    landed: [{ origin: 'ModA', filename: 'A.esp' }], refused: [],
  };
  const ONE_REFUSED: SelectionOutcome<PluginAddress> = {
    landed: [{ origin: 'ModA', filename: 'A.esp' }],
    refused: [{ item: { origin: 'ModB', filename: 'A.esp' }, reason: 'gone from disk' }],
  };

  it('keeps every call with its items as the caller typed them', () => {
    const reporter = recordingReporter();

    reporter.selectionOutcome(MESSAGE, FULLY_LANDED, nameOf);
    reporter.selectionOutcome(MESSAGE, ONE_REFUSED, nameOf);

    expect(reporter.selectionOutcomeCalls).toEqual([
      { message: MESSAGE, outcome: { landed: [{ origin: 'ModA', filename: 'A.esp' }], refused: [] } },
      {
        message: MESSAGE,
        outcome: {
          landed: [{ origin: 'ModA', filename: 'A.esp' }],
          refused: [{ item: { origin: 'ModB', filename: 'A.esp' }, reason: 'gone from disk' }],
        },
      },
    ]);
  });

  it('reports nothing for a fully landed outcome, as makeReporter surfaces nothing', () => {
    const reporter = recordingReporter();

    reporter.selectionOutcome(MESSAGE, FULLY_LANDED, nameOf);
    makeReporter({ warn: vi.fn(), error: vi.fn() }, 'records.delete').selectionOutcome(MESSAGE, FULLY_LANDED, nameOf);

    expect(reporter.reports).toEqual([]);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('reports a refusal as the one error makeReporter surfaces', () => {
    const reporter = recordingReporter();

    reporter.selectionOutcome(MESSAGE, ONE_REFUSED, nameOf);
    makeReporter({ warn: vi.fn(), error: vi.fn() }, 'records.delete').selectionOutcome(MESSAGE, ONE_REFUSED, nameOf);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: MESSAGE, detail: '"ModB/A.esp" (gone from disk)' },
    ]);
    expect(showErrorMessage.mock.calls).toEqual([
      ['Modbench: Could not delete 1 record. — "ModB/A.esp" (gone from disk)'],
    ]);
  });
});

describe('the scripted dialog', () => {
  it('answers each question with the next scripted answer and records what was asked', async () => {
    const dialog = scriptedDialog(undefined, ACCEPT);

    const outcomes = await offerTwice(dialog);

    expect(outcomes).toEqual([false, true]);
    expect(dialog.asked.map((q) => q.message.match(/in (\S+)/)?.[1])).toEqual(['A.esp', 'B.esp']);
    expect(dialog.asked.map((q) => q.buttons)).toEqual([[ACCEPT], [ACCEPT]]);
  });

  it('answers a question the script did not reach with the native cancel', async () => {
    const dialog = scriptedDialog(ACCEPT);

    const outcomes = await offerTwice(dialog);

    expect(outcomes).toEqual([true, false]);
    expect(dialog.asked).toHaveLength(2);
  });
});
