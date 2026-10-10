import * as vscode from 'vscode';
import { CONTAINER_SCHEMES } from '../drivingLib/recordDocument';
import { errorMessage } from '../ports/errorMessage';

const othersOverItsFile = (document: vscode.TextDocument): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter(({ uri }) =>
    uri.toString() !== document.uri.toString() && CONTAINER_SCHEMES.has(uri.scheme) && uri.fsPath === document.uri.fsPath);

/** Changes `document` to `text`, replacing only the span that differs, so an editor on it keeps its place. */
export async function takeText(document: vscode.TextDocument, text: string): Promise<void> {
  const own = document.getText();
  if (own === text) return;
  let start = 0;
  while (start < own.length && own[start] === text[start]) start++;
  let end = 0;
  while (end < own.length - start && end < text.length - start && own.at(-1 - end) === text.at(-1 - end)) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(own.length - end)), text.slice(start, text.length - end));
  // VS Code refuses an edit to a document another change reached first, and a closed document takes none.
  if (await vscode.workspace.applyEdit(edit) || document.getText() === text || document.isClosed) return;
  throw new Error(`VS Code did not change ${document.uri.toString(true)}.`);
}

/** A file's document and its child records' documents hold one text, saved or not (editor.md,
 *  Opening, story 10), as VS Code gives each tab a document of its own. */
export function holdOneTextPerFile(channel: Pick<vscode.LogOutputChannel, 'warn'>): vscode.Disposable {
  // The text each document took from another, which it holds with no change of its own to pass back.
  const taken = new Map<string, string>();
  let queue = Promise.resolve();
  const inTurn = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((err: unknown) => { channel.warn(`The documents over one file differ: ${errorMessage(err)}`); });
  };
  const take = async (document: vscode.TextDocument, text: string) => {
    if (document.getText() === text) return;
    const key = document.uri.toString();
    taken.set(key, text);
    try {
      await takeText(document, text);
    } catch (err) {
      taken.delete(key);
      throw err;
    }
  };
  const giveUnsaved = async (document: vscode.TextDocument) => {
    for (const other of othersOverItsFile(document)) await take(other, document.getText());
  };
  // A document that reads the file, opening or again, never overwrites another's unsaved text: it takes it.
  const takeUnsaved = async (document: vscode.TextDocument) => {
    const unsaved = othersOverItsFile(document).find(({ isDirty }) => isDirty);
    if (unsaved && !document.isClosed) await take(document, unsaved.getText());
  };

  return vscode.Disposable.from(
    // A change of text or of saved state: VS Code reports a document's first unsaved change before it is unsaved.
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges, reason }) => {
      const key = document.uri.toString();
      // A document holding only what it took has no change of its own, as when it then turns unsaved: passing
      // its text back would undo what was typed in the other since.
      if (taken.get(key) === document.getText()) return;
      taken.delete(key);
      const undoOrRedo = reason !== undefined;
      inTurn(async () => {
        if (document.isDirty || undoOrRedo) await giveUnsaved(document);
        else if (contentChanges.length > 0) await takeUnsaved(document);
      });
    }),
    vscode.workspace.onDidOpenTextDocument((document) => { inTurn(() => takeUnsaved(document)); }),
    // The others holding the saved text are saved too, which writes nothing the file does not hold.
    vscode.workspace.onDidSaveTextDocument((document) => {
      const saved = document.getText();
      inTurn(async () => {
        for (const other of othersOverItsFile(document)) if (other.isDirty && other.getText() === saved) await other.save();
      });
    }),
  );
}
