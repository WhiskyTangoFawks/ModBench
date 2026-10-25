import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FilterCodeLensProvider } from '../FilterCodeLensProvider';
import { fakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';

const ARMOR_SQL = 'SELECT form_key FROM "armo"';

vi.mock('vscode', () => ({
  CodeLens: class {
    constructor(public range: unknown, public command: unknown) {}
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  EventEmitter: class {
    event = () => {};
    fire() {}
    dispose() {}
  },
}));

function makeDocumentDeclaringEveryTextDocumentMember(text: string, fsPath: string): vscode.TextDocument {
  const uri = fakeUri(fsPath);
  const notImplemented = (): never => { throw new Error('not implemented in this fixture'); };
  return {
    uri, fileName: fsPath, isUntitled: false, languageId: 'sql', encoding: 'utf8',
    version: 1, isDirty: false, isClosed: false, eol: 1, lineCount: 1,
    save: () => Promise.resolve(true),
    lineAt: notImplemented,
    offsetAt: notImplemented,
    positionAt: notImplemented,
    getText: () => text,
    getWordRangeAtPosition: notImplemented,
    validateRange: notImplemented,
    validatePosition: notImplemented,
  };
}

function soleLens(lenses: readonly vscode.CodeLens[]): vscode.Command {
  const lens = present(lenses[0], 'the sole code lens returned');
  expect(lenses).toHaveLength(1);
  return present(lens.command, "the lens's command");
}

const APPLY = ['modbench.record.filter', '$(play) Apply as Filter'];
const CLEAR = ['modbench.record.clearFilter', '$(check) Active — click to clear'];

describe('FilterCodeLensProvider', () => {
  it('offers to apply a SQL document as the filter, naming the document', () => {
    const doc = makeDocumentDeclaringEveryTextDocumentMember(ARMOR_SQL, 'Untitled-1');

    const lens = soleLens(new FilterCodeLensProvider().provideCodeLenses(doc));

    expect([lens.command, lens.title]).toEqual(APPLY);
    expect(lens.arguments).toEqual([doc.uri]);
  });

  it.each<[string, (provider: FilterCodeLensProvider) => void, string, string[]]>([
    ['clears the filter on the document whose SQL is in force', (provider) => { provider.setActiveSql(ARMOR_SQL); }, ARMOR_SQL, CLEAR],
    ['offers to apply a document whose SQL differs from the filter in force', (provider) => { provider.setActiveSql('SELECT form_key FROM "weap"'); }, ARMOR_SQL, APPLY],
    ['ignores leading and trailing whitespace when comparing SQL', (provider) => { provider.setActiveSql(`  ${ARMOR_SQL}  `); }, `\n${ARMOR_SQL}\n`, CLEAR],
    ['offers to apply again once no filter is in force', (provider) => { provider.setActiveSql(ARMOR_SQL); provider.setActiveSql(null); }, ARMOR_SQL, APPLY],
  ])('%s', (_case, inForce, text, expected) => {
    const provider = new FilterCodeLensProvider();
    inForce(provider);

    const lens = soleLens(provider.provideCodeLenses(makeDocumentDeclaringEveryTextDocumentMember(text, '/scripts/armor.sql')));

    expect([lens.command, lens.title]).toEqual(expected);
  });
});
