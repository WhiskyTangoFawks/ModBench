import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';
import { recordArgumentOf, type RecordArgument } from '../drivingLib/recordArgument';
import { isReadFailed } from '../wire/readFailed';
import { recordTitle } from '../drivingLib/recordTitle';
import { readReferencedBy, type ReferencedByClient, type ReferencedByList } from './referrerTree';
import { referencesView, type ReferencesViewInput } from '../drivingLib/referencesView';

const REFERENCED_BY_SOURCE = 'modbench.referencedBy';

/** Where a record sits in its document: its FormKey, in its copy's document, or its winning copy's. */
type LocateRecord = (record: RecordArgument) => Promise<vscode.Location | { refused: string } | undefined>;

export interface RecordReferencedByDeps {
  client: ReferencedByClient & Pick<MEditClient, 'getComparison'>;
  reporter: Reporter;
  locateRecord: LocateRecord;
  /** The record of the tab in focus, else the one the user picks; undefined where none is. */
  focusedOrPickedRecord: () => Promise<string | undefined>;
}

async function titleOf(client: RecordReferencedByDeps['client'], formKey: string): Promise<string> {
  const comparison = await client.getComparison(formKey);
  const overrides = comparison && !isReadFailed(comparison) ? comparison.overrides : undefined;
  return `Referenced By: ${recordTitle(formKey, overrides)}`;
}

function referencedByInput(title: string, location: vscode.Location, resolve: () => Promise<ReferencedByList>): ReferencesViewInput<ReferencedByList> {
  return {
    title, location, contextValue: REFERENCED_BY_SOURCE, resolve,
    with: (moved) => referencedByInput(title, moved, resolve),
  };
}

async function recordAskedAbout(deps: RecordReferencedByDeps, argument: unknown): Promise<RecordArgument | 'none' | undefined> {
  if (argument !== undefined) return recordArgumentOf(argument) ?? 'none';
  const formKey = await deps.focusedOrPickedRecord();
  return formKey ? { kind: 'record', formKey } : undefined;
}

export function registerRecordReferencedBy(deps: RecordReferencedByDeps): vscode.Disposable {
  const { reporter } = deps;
  let lists = 0;
  return vscode.commands.registerCommand('modbench.record.referencedBy', async (argument?: unknown) => {
    const view = await referencesView();
    if (!view) return;
    const record = await recordAskedAbout(deps, argument);
    if (record === 'none') {
      reporter.report('error', 'Could not list what references a record.', 'What was given names no record.');
      return;
    }
    if (!record) return;
    const failMessage = `Could not list what references ${record.formKey}.`;
    await reportFailure(reporter, failMessage, async () => {
      const [title, location] = await Promise.all([titleOf(deps.client, record.formKey), deps.locateRecord(record)]);
      if (!location || 'refused' in location) {
        reporter.report('error', failMessage, location?.refused ?? `No active plugin holds ${record.formKey}.`);
        return;
      }
      const list = String(++lists);
      view.setInput(referencedByInput(title, location, () => readReferencedBy(deps.client, record.formKey, list)));
    });
  });
}
