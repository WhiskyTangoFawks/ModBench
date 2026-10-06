import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import type { MEditClient, RecordEditEnvelope } from '../client';
import type { PluginAddress } from '../wire/pluginAddress';
import type { PathHop } from '../wire/messages';
import type { RecordDocument } from '../drivingLib/recordDocument';
import { errorMessage } from '../ports/errorMessage';
import type { EditAddress } from './followRecord';

/** A file or folder an edit moves. */
export interface SourceMove { from: vscode.Uri; to: vscode.Uri }

/** What any record-panel gesture needs to write, whichever surface it arrives from — the webview's
 *  inline and keyboard edits through the message router, the right-click menus straight from the
 *  command they invoke. */
export interface RecordWriteDeps {
  // Injected rather than imported so this stays callable from a plain unit test.
  meditClient: Pick<MEditClient, 'getEditChanges'>;
  // The document carrying the record: an open tab's, or the one the record opens as.
  documentOf: (address: EditAddress) => Promise<RecordDocument>;
  // Told before VS Code moves a file, so a tab the move takes along shows its record where it lands.
  moving: (moves: readonly SourceMove[], edited: EditAddress, newFormKey: string | undefined) => void;
  // Each edit is built on the text the one before it left.
  oneAtATime: <T>(edit: () => Promise<T>) => Promise<T>;
  // The native Source Control panel does not pick up a field edit's working-tree change on its own.
  // The records and their badges are not the edit's to touch: they follow mEdit's changed rows.
  refreshSourceControlFor: (plugin: PluginAddress) => void;
  reporter: Reporter;
}

/** Runs each edit given it after the one before it settles. */
export function oneAtATime(): RecordWriteDeps['oneAtATime'] {
  let last: Promise<unknown> = Promise.resolve();
  return (edit) => {
    const next = last.then(edit, edit);
    last = next.catch(() => undefined);
    return next;
  };
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
  const outcome = await deps.meditClient.getEditChanges(address.formKey, address.plugin, envelope, document.getText());
  if (!outcome.applied) {
    deps.reporter.report('warning', `${field}: ${outcome.message}`);
    return undefined;
  }
  if (outcome.moves.length === 0 && outcome.documents.length === 0) return outcome.newFormKey;

  const moves = outcome.moves.map(({ from, to }) => ({ from: vscode.Uri.file(from), to: vscode.Uri.file(to) }));
  const changes = new vscode.WorkspaceEdit();
  for (const { from, to } of moves) changes.renameFile(from, to);
  const changed = outcome.documents.map(({ path, text }) => {
    const uri = documentAt(path, document.uri);
    changes.createFile(uri, { ignoreIfExists: true });
    changes.replace(uri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), text);
    return uri;
  });
  deps.moving(moves, address, outcome.newFormKey);
  if (!await vscode.workspace.applyEdit(changes)) throw new Error('VS Code did not apply the changes mEdit answered.');
  const unsaved = await Promise.all(changed.map(async (uri) => {
    const saved = await vscode.workspace.openTextDocument(uri);
    return saved.isDirty && !await saved.save() ? [uri.fsPath] : [];
  }));
  if (unsaved.flat().length > 0) throw new Error(`VS Code did not save ${unsaved.flat().join(', ')}.`);
  deps.refreshSourceControlFor(address.plugin);
  return outcome.newFormKey;
}

// The file the edit read is changed through the document it read, so a child record's tab keeps its own.
function documentAt(path: string, read: vscode.Uri): vscode.Uri {
  const file = vscode.Uri.file(path);
  return file.path === read.path ? read : file;
}
