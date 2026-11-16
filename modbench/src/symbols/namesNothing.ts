import * as vscode from 'vscode';
import type { PluginAddress } from '../client';
import { addNamed, type Named } from '../drivingLib/namedPlugins';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import type { InTurn } from '../ports/bounded';
import { coalesced } from '../ports/coalesced';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { placeIn } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { inOrder, type NamesNothing, type SymbolKinds } from './symbolKind';
import type { NamedPlugin } from './scriptsNamed';

interface NamesNothingDeps {
  kinds: SymbolKinds;
  collection: vscode.DiagnosticCollection;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** The text of a file on disk, which no document opens; undefined where it is gone. */
  savedText: (path: string) => Promise<string | undefined>;
  /** What a name resolves to is read from its value; judging stands while the value is the same object. */
  instance?: { readonly value: object };
  /** Told whenever what a name resolves to, or what a file names, may have changed: of one plugin's files, or of all. */
  onChanged: (listener: (plugin?: PluginAddress, keys?: readonly string[]) => void) => { dispose: () => unknown };
  /** The one bound on requests, and what it holds of mEdit's answers, dropped whenever a file may have changed. */
  asker: { inTurn: InTurn; forget: (plugin?: PluginAddress) => void };
}

const isFile = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file';

const namesNothingIn = async (kinds: SymbolKinds, file: string, text: string): Promise<NamesNothing[] | undefined> => {
  const found = await Promise.all(inOrder(kinds).map((kind) => kind.namesNothingIn?.({ uri: { fsPath: file }, getText: () => text }) ?? Promise.resolve([])));
  return found.every((names) => names !== undefined) ? found.flat() : undefined;
};

const diagnosticsOf = (file: string, text: string, found: readonly NamesNothing[]): vscode.Diagnostic[] =>
  [...found].sort((a, b) => a.start - b.start).map(({ start, end, name, why }) => {
    const { start: from, end: to } = placeIn(file, text, start, end);
    return modbenchDiagnostic(new vscode.Range(from.line, from.character, to.line, to.character), `${name} names nothing. ${why}`, vscode.DiagnosticSeverity.Warning);
  });

interface OpenDocument { latest: vscode.TextDocument; turn: () => void }

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

const NO_FILES: readonly string[] = [];

/** A reference that names nothing is a problem on its place in its file, open or not (symbols.md, The features, story 8). */
export function registerNamesNothing({ kinds, collection, reporter, savedText, instance, onChanged, asker }: NamesNothingDeps): vscode.Disposable {
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
      if (found === undefined || latest.get(file) !== mine) return;
      collection.set(vscode.Uri.file(file), diagnosticsOf(file, text ?? '', found));
      told.delete(file);
    } catch (error) {
      tellOnce(file, error);
    }
  };

  // Undefined where any kind cannot answer: what is shown then stays.
  const filesHolding = async (only: readonly NamedPlugin[] | undefined): Promise<(readonly string[])[] | undefined> => {
    const lists = await Promise.all(inOrder(kinds).map(async (kind) => {
      try {
        return kind.filesNamingNothing === undefined ? NO_FILES : await kind.filesNamingNothing(only);
      } catch (error) {
        tellOnce('files', error);
        return undefined;
      }
    }));
    const answered = lists.filter((list) => list !== undefined);
    if (answered.length < lists.length) return undefined;
    told.delete('files');
    return answered;
  };

  let wholeWanted = true;
  let mustJudge = true;
  let judgedOf: { lists: (readonly string[])[]; value: object | undefined } | undefined;
  const asking = new Map<string, Named>();
  const judgeAll = coalesced(async () => {
    const only = wholeWanted ? undefined : [...asking.values()].map(({ plugin, keys }) => ({ ...plugin, keys: keys && [...keys] }));
    wholeWanted = false;
    asking.clear();
    const held = vscode.workspace.textDocuments.filter(isFile);
    const lists = await filesHolding(only);
    const value = instance?.value;
    const last = judgedOf;
    if (lists !== undefined && last !== undefined && !mustJudge && last.value === value && last.lists.length === lists.length && lists.every((list, at) => list === last.lists[at])) return;
    mustJudge = false;
    const files = lists?.flat();
    const closed = (files ?? []).filter((file) => !held.some((document) => document.uri.fsPath === file));
    const judging = new Set([...held.map((document) => document.uri.fsPath), ...closed]);
    await Promise.all([
      ...held.map((document) => asker.inTurn(() => judged(document.uri.fsPath, () => heldText(document)), true)),
      ...closed.map((file) => asker.inTurn(() => judged(file, () => savedText(file)))),
    ]);
    if (files === undefined) {
      if (only === undefined) wholeWanted = true;
      for (const { keys, ...plugin } of only ?? []) addNamed(asking, plugin, keys);
      shown = new Set([...shown, ...judging]);
      return;
    }
    judgedOf = lists && { lists, value };
    for (const file of shown) if (!judging.has(file)) collection.delete(vscode.Uri.file(file));
    shown = judging;
  });

  const open = judgingOpenDocuments((file, text) => asker.inTurn(() => judged(file, text), true));

  judgeAll();
  return vscode.Disposable.from(
    onChanged((plugin, keys) => {
      if (plugin === undefined) wholeWanted = true;
      else addNamed(asking, plugin, keys);
      judgeAll();
    }),
    vscode.workspace.onDidOpenTextDocument(open.judge),
    vscode.workspace.onDidChangeTextDocument(({ document }) => { open.judge(document); }),
    vscode.workspace.onDidCloseTextDocument((document) => { open.forget(document); asker.forget(); mustJudge = true; judgeAll(); }),
  );
}
