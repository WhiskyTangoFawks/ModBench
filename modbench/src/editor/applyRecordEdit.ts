import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import type { MEditClient, RecordEditEnvelope, SourceChanges } from '../client';
import type { PluginAddress } from '../wire/pluginAddress';
import type { PathHop } from '../wire/messages';
import type { RecordDocument } from '../drivingLib/recordDocument';
import { applyWorkspaceChanges, type FileMove, type WorkspaceChanges } from '../drivingLib/applyWorkspaceChanges';
import { applyAnswered } from '../drivingLib/applyAnswered';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import type { OneAtATime } from '../drivingLib/oneAtATime';
import { errorMessage } from '../ports/errorMessage';
import type { EditAddress } from './recordTab';

/** What any record-panel gesture needs to write, whichever surface it arrives from — the webview's
 *  inline and keyboard edits through the message router, the right-click menus straight from the
 *  command they invoke. */
export interface RecordWriteDeps {
  meditClient: Pick<MEditClient, 'getEditChanges'>;
  unsaved: SourceEditing['unsaved'];
  // The document carrying the record: an open tab's, or the one the record opens as.
  documentOf: (address: EditAddress) => Promise<RecordDocument>;
  // Told before VS Code moves a file, so a tab the move takes along shows its record where it lands.
  // What it answers undoes that, when VS Code makes no move.
  moving: (moves: readonly FileMove[], edited: EditAddress, newFormKey: string | undefined) => () => void;
  // Each edit is built on the text the one before it left.
  oneAtATime: OneAtATime;
  // The native Source Control panel does not pick up a field edit's working-tree change on its own.
  // The records and their badges are not the edit's to touch: they follow mEdit's changed rows.
  refreshSourceControlFor: (plugin: PluginAddress) => void;
  reporter: Reporter;
}

function spellField(path: PathHop[]): string {
  return path.map((hop, i) => hop.kind === 'index' ? `[${hop.index}]` : i === 0 ? hop.name : `.${hop.name}`).join('');
}

/** Changes the documents mEdit answers for the edit and saves them (ADR-0001); a refusal changes
 *  nothing and is a notification (editor.md, Reporting, story 1). Resolves the new FormKey an edit
 *  of the FormID gives. */
export async function applyRecordEdit(
  deps: RecordWriteDeps, address: EditAddress, envelope: RecordEditEnvelope,
): Promise<string | undefined> {
  const field = spellField(envelope.path);
  try {
    return await deps.oneAtATime(() => editDocuments(deps, address, envelope, field));
  } catch (err) {
    deps.reporter.report('error', `Could not edit ${field}.`, errorMessage(err));
    return undefined;
  }
}

async function editDocuments(
  deps: RecordWriteDeps, address: EditAddress, envelope: RecordEditEnvelope, field: string,
): Promise<string | undefined> {
  const carrying = await deps.documentOf(address);
  if ('refused' in carrying) throw new Error(carrying.refused);
  const document = await vscode.workspace.openTextDocument(carrying.uri);
  const outcome = await deps.meditClient.getEditChanges(address.formKey, address.plugin, envelope, document.getText(), deps.unsaved());
  if (!outcome.applied) {
    deps.reporter.report('warning', `${field}: ${outcome.message}`);
    return undefined;
  }
  if (isNoChange(outcome)) return outcome.newFormKey;

  const applying = {
    applyWorkspaceChanges: (items: readonly WorkspaceChanges[]) => applyWorkspaceChanges(items, {
      read: document.uri,
      moving: (moves) => deps.moving(moves, address, outcome.newFormKey),
    }),
    refreshSourceControlFor: deps.refreshSourceControlFor,
  };
  const applied = await applyAnswered(
    applying, deps.reporter, [outcome], [address.plugin],
    { notApplied: `Could not edit ${field}.`, notSaved: `Could not save the edit of ${field}.` });
  return applied ? outcome.newFormKey : undefined;
}

const isNoChange = ({ moves, deletions, documents }: SourceChanges) =>
  moves.length === 0 && deletions.length === 0 && documents.length === 0;
