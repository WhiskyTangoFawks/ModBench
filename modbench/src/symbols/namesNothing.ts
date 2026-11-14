import * as vscode from 'vscode';
import type { PluginAddress } from '../client';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { coalesced } from '../ports/coalesced';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { placeIn } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { pluginAddressKey } from '../wire/pluginAddress';
import { inOrder, type NamesNothing, type SymbolKinds } from './symbolKind';

interface NamesNothingDeps {
  kinds: SymbolKinds;
  collection: vscode.DiagnosticCollection;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** The text of a file on disk, which no document opens; undefined where it is gone. */
  savedText: (path: string) => Promise<string | undefined>;
  /** Told whenever what a name resolves to, or what a file names, may have changed: of one plugin's files, or of all. */
  onChanged: (listener: (plugin?: PluginAddress) => void) => { dispose: () => unknown };
}

const isFile = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file';

const namesNothingIn = async (kinds: SymbolKinds, file: string, text: string): Promise<NamesNothing[]> =>
  (await Promise.all(inOrder(kinds).map((kind) => kind.namesNothingIn?.({ uri: { fsPath: file }, getText: () => text }) ?? Promise.resolve([])))).flat();

interface OpenDocument { latest: vscode.TextDocument; turn: () => void }

/** One judgement of a document at a time, of the text it holds when its turn comes. */
function judgingOpenDocuments(judged: (file: string, text: () => string) => Promise<void>) {
  const documents = new Map<string, OpenDocument>();
  return {
    judge: (document: vscode.TextDocument) => {
      if (!isFile(document)) return;
      const path = document.uri.fsPath;
      const entry: OpenDocument = documents.get(path) ?? { latest: document, turn: coalesced(() => judged(path, () => heldText(entry.latest))) };
      entry.latest = document;
      documents.set(path, entry);
      entry.turn();
    },
    forget: (document: vscode.TextDocument) => { documents.delete(document.uri.fsPath); },
  };
}

/** A reference that names nothing is a problem on its place in its file, open or not (symbols.md, The features, story 8). */
export function registerNamesNothing({ kinds, collection, reporter, savedText, onChanged }: NamesNothingDeps): vscode.Disposable {
  const told = new Set<string>();
  const latest = new Map<string, number>();
  let shown = new Set<string>();

  const tellOnce = (key: string, error: unknown) => {
    if (!told.has(key)) reporter.shownOnSurface('warning', 'The Problems panel shows the last names that name nothing.', errorMessage(error));
    told.add(key);
  };

  // A judgement that a later one overtook is dropped.
  const judged = async (file: string, textOf: () => string | undefined | Promise<string | undefined>) => {
    const mine = (latest.get(file) ?? 0) + 1;
    latest.set(file, mine);
    try {
      const text = await textOf();
      const found = text === undefined ? [] : await namesNothingIn(kinds, file, text);
      if (latest.get(file) !== mine) return;
      collection.set(vscode.Uri.file(file), found.sort((a, b) => a.start - b.start).map(({ start, end, name, why }) => {
        const { start: from, end: to } = placeIn(file, text ?? '', start, end);
        return modbenchDiagnostic(new vscode.Range(from.line, from.character, to.line, to.character), `${name} names nothing. ${why}`, vscode.DiagnosticSeverity.Warning);
      }));
      told.delete(file);
    } catch (error) {
      tellOnce(file, error);
    }
  };

  // Undefined where any kind cannot answer: what is shown then stays.
  const filesHolding = async (only: readonly PluginAddress[] | undefined): Promise<string[] | undefined> => {
    const lists = await Promise.all(inOrder(kinds).map(async (kind) => {
      try {
        return kind.filesNamingNothing === undefined ? [] : await kind.filesNamingNothing(only);
      } catch (error) {
        tellOnce('files', error);
        return undefined;
      }
    }));
    const answered = lists.filter((list) => list !== undefined);
    if (answered.length < lists.length) return undefined;
    told.delete('files');
    return answered.flat();
  };

  let wholeWanted = true;
  const asking = new Map<string, PluginAddress>();
  const judgeAll = coalesced(async () => {
    const only = wholeWanted ? undefined : [...asking.values()];
    wholeWanted = false;
    asking.clear();
    const held = vscode.workspace.textDocuments.filter(isFile);
    const files = await filesHolding(only);
    const closed = (files ?? []).filter((file) => !held.some((document) => document.uri.fsPath === file));
    const judging = new Set([...held.map((document) => document.uri.fsPath), ...closed]);
    await Promise.all([
      ...held.map((document) => judged(document.uri.fsPath, () => heldText(document))),
      ...closed.map((file) => judged(file, () => savedText(file))),
    ]);
    if (files === undefined) {
      shown = new Set([...shown, ...judging]);
      return;
    }
    for (const file of shown) if (!judging.has(file)) collection.delete(vscode.Uri.file(file));
    shown = judging;
  });

  const open = judgingOpenDocuments(judged);

  judgeAll();
  return vscode.Disposable.from(
    onChanged((plugin) => {
      if (plugin === undefined) wholeWanted = true;
      else asking.set(pluginAddressKey(plugin), plugin);
      judgeAll();
    }),
    vscode.workspace.onDidOpenTextDocument(open.judge),
    vscode.workspace.onDidChangeTextDocument(({ document }) => { open.judge(document); }),
    vscode.workspace.onDidCloseTextDocument((document) => { open.forget(document); judgeAll(); }),
  );
}
