import * as vscode from 'vscode';
import { CHILD_RECORD_SCHEME } from '../drivingLib/recordDocument';
import { errorMessage } from '../ports/errorMessage';

const OVER_A_FILE = new Set(['file', CHILD_RECORD_SCHEME]);

const othersOverItsFile = (document: vscode.TextDocument): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter(({ uri }) =>
    uri.toString() !== document.uri.toString() && OVER_A_FILE.has(uri.scheme) && uri.fsPath === document.uri.fsPath);

/** Changes `document` to `text`, replacing only the span that differs, so an editor on it keeps its
 *  place; false when it already held `text`. */
export async function takeText(document: vscode.TextDocument, text: string): Promise<boolean> {
  const own = document.getText();
  if (own === text) return false;
  let start = 0;
  while (start < own.length && own[start] === text[start]) start++;
  let end = 0;
  while (end < own.length - start && end < text.length - start && own.at(-1 - end) === text.at(-1 - end)) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(own.length - end)), text.slice(start, text.length - end));
  if (!await vscode.workspace.applyEdit(edit)) throw new Error(`VS Code did not change ${document.uri.toString(true)}.`);
  return true;
}

/** A file's document and its child records' documents hold one text, saved or not (editor.md,
 *  Opening, story 10), as VS Code gives each tab a document of its own. */
export function holdOneTextPerFile(channel: Pick<vscode.LogOutputChannel, 'warn'>): vscode.Disposable {
  // The text each document takes from another, so its own change event is not passed back.
  const taking = new Map<string, string>();
  let queue = Promise.resolve();
  const inTurn = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((err: unknown) => { channel.warn(`The documents over one file differ: ${errorMessage(err)}`); });
  };
  const take = async (document: vscode.TextDocument, text: string) => {
    const key = document.uri.toString();
    taking.set(key, text);
    try {
      if (!await takeText(document, text)) taking.delete(key);
    } catch (err) {
      taking.delete(key);
      throw err;
    }
  };

  return vscode.Disposable.from(
    // A change of text or of saved state: VS Code reports a document's first unsaved change before it is unsaved.
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      const key = document.uri.toString();
      if (contentChanges.length > 0 && taking.get(key) === document.getText()) {
        taking.delete(key);
        return;
      }
      inTurn(async () => {
        // Two saved documents each read the file on their own.
        for (const other of othersOverItsFile(document)) if (document.isDirty || other.isDirty) await take(other, document.getText());
      });
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      const unsaved = othersOverItsFile(document).find(({ isDirty }) => isDirty);
      if (unsaved) inTurn(() => take(document, unsaved.getText()));
    }),
    // The others holding the saved text are saved too, which writes nothing the file does not hold.
    vscode.workspace.onDidSaveTextDocument((document) => {
      const saved = document.getText();
      inTurn(async () => {
        for (const other of othersOverItsFile(document)) if (other.isDirty && other.getText() === saved) await other.save();
      });
    }),
  );
}
