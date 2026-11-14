import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { coalesced } from '../ports/coalesced';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { placeIn } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { inOrder, type SymbolKinds } from './symbolKind';

interface NamesNothingDeps {
  kinds: SymbolKinds;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** The text of a file that is not open, as the box that owns plugin source reads it. */
  readText: (path: string) => Promise<string>;
  /** Told whenever what a name resolves to, or what a file names, may have changed. */
  onChanged: (listener: () => void) => { dispose: () => unknown };
}

const isFile = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file';

/** A reference that names nothing is a problem on its place in its file, open or not (symbols.md, The features, story 8). */
export function registerNamesNothing({ kinds, reporter, readText, onChanged }: NamesNothingDeps): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('modbench-names');
  const told = new Set<string>();
  let shown = new Set<string>();

  const tellOnce = (key: string, error: unknown) => {
    if (!told.has(key)) reporter.shownOnSurface('warning', 'The Problems panel shows the last names that name nothing.', errorMessage(error));
    told.add(key);
  };

  const publish = async (file: string, text: string) => {
    const found = (await Promise.all(inOrder(kinds).map((kind) => kind.namesNothingIn?.({ uri: { fsPath: file }, getText: () => text }) ?? Promise.resolve([])))).flat();
    collection.set(vscode.Uri.file(file), found.sort((a, b) => a.start - b.start).map(({ start, end, name, why }) => {
      const { start: from, end: to } = placeIn(file, text, start, end);
      return modbenchDiagnostic(new vscode.Range(from.line, from.character, to.line, to.character), `${name} names nothing. ${why}`, vscode.DiagnosticSeverity.Warning);
    }));
  };

  const judged = async (file: string, textOf: () => string | Promise<string>) => {
    try {
      await publish(file, await textOf());
      told.delete(file);
    } catch (error) {
      tellOnce(file, error);
    }
  };

  const filesHolding = async (): Promise<string[]> => {
    const asked = await Promise.all(inOrder(kinds).map(async (kind) => {
      try {
        return await kind.filesNamingNothing?.() ?? [];
      } catch (error) {
        tellOnce('files', error);
        return undefined;
      }
    }));
    return asked.every((answer) => answer !== undefined) ? asked.flat() : [];
  };

  const judgeAll = coalesced(async () => {
    const open = vscode.workspace.textDocuments.filter(isFile);
    const closed = (await filesHolding()).filter((file) => !open.some((document) => document.uri.fsPath === file));
    const judging = new Set([...open.map((document) => document.uri.fsPath), ...closed]);
    await Promise.all([
      ...open.map((document) => judged(document.uri.fsPath, () => heldText(document))),
      ...closed.map((file) => judged(file, () => readText(file))),
    ]);
    for (const file of shown) if (!judging.has(file)) collection.delete(vscode.Uri.file(file));
    shown = judging;
  });
  judgeAll();
  const judgeOne = (document: vscode.TextDocument) => { if (isFile(document)) void judged(document.uri.fsPath, () => heldText(document)); };
  return vscode.Disposable.from(
    collection,
    onChanged(judgeAll),
    vscode.workspace.onDidOpenTextDocument(judgeOne),
    vscode.workspace.onDidChangeTextDocument(({ document }) => { judgeOne(document); }),
    vscode.workspace.onDidCloseTextDocument(() => { judgeAll(); }),
  );
}
