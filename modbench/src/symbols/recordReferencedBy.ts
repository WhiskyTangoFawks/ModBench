import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';
import { isReadFailed } from '../wire/readFailed';
import { recordTitle } from '../drivingLib/recordTitle';
import { readReferencedBy, type ReferencedByClient, type ReferencedByList } from './referrerTree';
import { referencesView, type ReferencesViewInput } from '../drivingLib/referencesView';
import type { RecordNamed } from './symbolKind';

const REFERENCED_BY_SOURCE = 'modbench.referencedBy';

export interface RecordReferencedByDeps {
  client: ReferencedByClient & Pick<MEditClient, 'getComparison'>;
  reporter: Pick<Reporter, 'report'>;
  /** Where the list anchors: the record's FormKey in its winning copy; else why it has none. */
  anchorOf: (record: RecordNamed) => Promise<vscode.Location | { refused: string }>;
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

/** `referenced by` on a record: the records that reference it, as a tree in VS Code's References view, anchored at its
 *  FormKey in its winning copy. */
export function recordReferencedBy({ client, reporter, anchorOf }: RecordReferencedByDeps): (record: RecordNamed) => Promise<void> {
  let lists = 0;
  return async (record) => {
    const view = await referencesView();
    if (!view) return;
    const { formKey } = record;
    const failMessage = `Could not list what references ${formKey}.`;
    await reportFailure(reporter, failMessage, async () => {
      const [title, anchor] = await Promise.all([titleOf(client, formKey), anchorOf(record)]);
      if ('refused' in anchor) {
        reporter.report('error', failMessage, anchor.refused);
        return;
      }
      const list = String(++lists);
      view.setInput(referencedByInput(title, anchor, () => readReferencedBy(client, formKey, list)));
    });
  };
}
