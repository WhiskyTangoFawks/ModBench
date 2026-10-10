import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Log } from '../ports/log';
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';
import { recordArgumentOf, type RecordArgument } from '../drivingLib/recordArgument';
import { isReadFailed } from '../wire/readFailed';
import { pickRecord } from './recordPicker';
import { recordTitle } from './recordTitle';
import { readReferencedBy, type ConditionsOf, type ReferencedByClient, type ReferencedByList } from './referencedByList';
import { REFERENCES_VIEW_EXTENSION, referencesView, type ReferencesViewInput } from './referencesView';

const REFERENCED_BY_SOURCE = 'modbench.referencedBy';

/** Where a record sits in its document: its FormKey, in its copy's document, or its winning copy's. */
export type LocateRecord = (record: RecordArgument) => Promise<vscode.Location | { refused: string } | undefined>;

export interface ReferencedByDeps {
  client: ReferencedByClient & Pick<MEditClient, 'getComparison' | 'searchRecords'>;
  log: Log;
  reporter: Reporter;
  locateRecord: LocateRecord;
  recordInFocus: () => string | undefined;
  conditionsOf: ConditionsOf;
}

async function titleOf(client: ReferencedByDeps['client'], formKey: string): Promise<string> {
  const comparison = await client.getComparison(formKey).catch(() => undefined);
  const overrides = comparison && !isReadFailed(comparison) ? comparison.overrides : undefined;
  return `Referenced By: ${recordTitle(formKey, overrides)}`;
}

function referencedByInput(title: string, location: vscode.Location, resolve: () => Promise<ReferencedByList>): ReferencesViewInput {
  return {
    title, location, contextValue: REFERENCED_BY_SOURCE, resolve,
    with: (moved) => referencedByInput(title, moved, resolve),
  };
}

async function recordAskedAbout(deps: ReferencedByDeps, argument: unknown): Promise<RecordArgument | 'none' | undefined> {
  if (argument !== undefined) return recordArgumentOf(argument) ?? 'none';
  const formKey = deps.recordInFocus() ?? await pickRecord({ meditClient: deps.client, reporter: deps.reporter }, '', []);
  return formKey ? { kind: 'record', formKey } : undefined;
}

export function registerReferencedBy(deps: ReferencedByDeps): vscode.Disposable {
  const { reporter } = deps;
  let lists = 0;
  return vscode.commands.registerCommand('modbench.record.referencedBy', async (argument?: unknown) => {
    const view = await referencesView();
    if (!view) {
      reporter.report('error', 'Referenced By needs VS Code\'s built-in Reference Search View.', `Enable the extension ${REFERENCES_VIEW_EXTENSION}.`);
      return;
    }
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
      view.setInput(referencedByInput(title, location, () => readReferencedBy(deps.client, deps.log, record.formKey, list, deps.conditionsOf)));
    });
  });
}
