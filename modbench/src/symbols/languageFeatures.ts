import * as vscode from 'vscode';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { showDefinition } from './definitionShown';
import type { renameSymbol } from './renameSymbol';
import { askedAt, inOrder, type Listed, type SymbolKinds } from './symbolKind';
import { reportedForFeature } from './symbolPlaces';

interface LanguageFeaturesDeps {
  kinds: SymbolKinds;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  reveal: (copy: CopyAt) => Promise<void>;
  rename: ReturnType<typeof renameSymbol>;
}

const pluginSource: vscode.DocumentSelector = { language: 'json' };
// symbols.md, The features, story 2: any file an owner of files reports may name a symbol.
const ownedFiles: vscode.DocumentSelector = [pluginSource, { scheme: 'file' }];

type Spanned = { readonly start: number; readonly end: number };

const rangeIn = (document: vscode.TextDocument, { start, end }: Spanned): vscode.Range =>
  new vscode.Range(document.positionAt(start), document.positionAt(end));

class ListedSymbol extends vscode.SymbolInformation {
  constructor(readonly listed: Listed) {
    super(listed.name, listed.icon, listed.detail, listed.location);
  }
}

/** VS Code's language features, each an entry point that asks the symbol under the place, of whatever kind, for its
 *  answer (symbols.md, The features). */
export function registerLanguageFeatures({ kinds, reporter, reveal, rename }: LanguageFeaturesDeps): vscode.Disposable {
  const at = (document: vscode.TextDocument, position: vscode.Position) => askedAt(kinds, document, document.offsetAt(position));
  const workspaceSymbols: vscode.WorkspaceSymbolProvider<ListedSymbol> = {
    async provideWorkspaceSymbols(query) {
      const wanted = query.trim();
      if (wanted === '') return [];
      const listed = await Promise.all(inOrder(kinds).map((kind) => kind.symbolsFor(wanted)));
      return listed.flat().map((symbol) => new ListedSymbol(symbol));
    },
    async resolveWorkspaceSymbol(symbol) {
      const location = await symbol.listed.resolve?.();
      if (location !== undefined) symbol.location = location;
      return symbol;
    },
  };
  return vscode.Disposable.from(
    vscode.languages.registerHoverProvider(ownedFiles, {
      async provideHover(document, position) {
        const asked = await at(document, position);
        return asked && new vscode.Hover(new vscode.MarkdownString((await asked.hover()).join('\n\n')), rangeIn(document, asked));
      },
    }),
    vscode.languages.registerCompletionItemProvider(ownedFiles, {
      async provideCompletionItems(document, position) {
        for (const kind of inOrder(kinds)) {
          const found = await kind.completionsAt(document, document.offsetAt(position));
          if (found === undefined) continue;
          const items = found.items.map(({ label, detail, insertText }) => {
            const item = new vscode.CompletionItem({ label, description: detail }, found.icon);
            item.range = rangeIn(document, found);
            if (insertText !== undefined) {
              item.insertText = insertText;
              item.filterText = `${label} ${insertText}`;
            }
            return item;
          });
          return new vscode.CompletionList(items, found.isIncomplete ?? false);
        }
        return undefined;
      },
    }),
    vscode.languages.registerDefinitionProvider(ownedFiles, {
      async provideDefinition(document, position) {
        const asked = await at(document, position);
        if (asked === undefined) return undefined;
        const definition = await asked.definition();
        if ('none' in definition) return undefined;
        if ('refused' in definition) {
          reporter.shownOnSurface('warning', `Go to Definition cannot go to ${asked.name}.`, definition.refused);
          return undefined;
        }
        try {
          const theNameAskedAbout = new vscode.Location(document.uri, rangeIn(document, asked));
          return await showDefinition(definition, reveal) ?? theNameAskedAbout;
        } catch (error) {
          reporter.shownOnSurface('warning', `Go to Definition cannot show ${asked.name}.`, errorMessage(error));
          return undefined;
        }
      },
    }),
    vscode.languages.registerReferenceProvider(ownedFiles, {
      async provideReferences(document, position) {
        const asked = await at(document, position);
        if (asked === undefined) return undefined;
        const found = await asked.references();
        if ('refused' in found) {
          reporter.shownOnSurface('warning', `Find All References cannot list what names ${asked.name}.`, found.refused);
          return [];
        }
        return [...reportedForFeature(reporter, asked.name, found).locations];
      },
    }),
    vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbols),
    vscode.languages.registerRenameProvider(ownedFiles, {
      async prepareRename(document, position) {
        const { placeholder, ...span } = await rename.prepare(document, document.offsetAt(position));
        return { range: rangeIn(document, span), placeholder };
      },
      // The gesture applies its own changes, and writes after them what no workspace edit can hold.
      async provideRenameEdits(document, position, newName) {
        await rename.rename(document, document.offsetAt(position), newName);
        return new vscode.WorkspaceEdit();
      },
    }),
  );
}
