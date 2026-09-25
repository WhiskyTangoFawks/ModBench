import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Every member `vscode.TextDocument` declares — `provideCodeLenses` reads only `.uri` and
// `.getText()`, but it implements `vscode.CodeLensProvider`, so the double has to satisfy the
// real (large) interface, not a narrowed one.
function makeDocument(text: string, fsPath: string, isUntitled = false): vscode.TextDocument {
  const uri = fakeUri(fsPath);
  const notImplemented = (): never => { throw new Error('not implemented in this fixture'); };
  return {
    uri, fileName: fsPath, isUntitled, languageId: 'sql', encoding: 'utf8',
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

// The command and its arguments off the sole lens a `provideCodeLenses` call returned.
function soleLens(lenses: readonly vscode.CodeLens[]): vscode.Command {
  const lens = present(lenses[0], 'the sole code lens returned');
  expect(lenses).toHaveLength(1);
  return present(lens.command, "the lens's command");
}

describe('FilterCodeLensProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  // plugins.md, Pickers, Record filter: "on any SQL document".
  it('offers to apply an untitled SQL document as the filter, naming the document', () => {
    const doc = makeDocument(ARMOR_SQL, 'Untitled-1', true);

    const lens = soleLens(new FilterCodeLensProvider().provideCodeLenses(doc));

    expect(lens.command).toBe('modbench.record.filter');
    expect(lens.arguments).toEqual([doc.uri]);
  });

  it('offers to apply a SQL document outside the scripts folder', () => {
    const doc = makeDocument(ARMOR_SQL, '/elsewhere/queries/armor.sql');

    const lens = soleLens(new FilterCodeLensProvider().provideCodeLenses(doc));

    expect(lens.command).toBe('modbench.record.filter');
    expect(lens.arguments).toEqual([doc.uri]);
  });

  it('reads that the filter is active, and clears it, on the document whose SQL is in force', () => {
    const provider = new FilterCodeLensProvider();
    provider.setActiveSql(ARMOR_SQL);

    const lens = soleLens(provider.provideCodeLenses(makeDocument(ARMOR_SQL, 'Untitled-1', true)));

    expect(lens.command).toBe('modbench.record.clearFilter');
    expect(lens.title).toContain('Active');
  });

  it('offers to apply a document whose SQL differs from the filter in force', () => {
    const provider = new FilterCodeLensProvider();
    provider.setActiveSql('SELECT form_key FROM "weap"');

    expect(soleLens(provider.provideCodeLenses(makeDocument(ARMOR_SQL, '/scripts/armor.sql'))).command)
      .toBe('modbench.record.filter');
  });

  it('ignores leading and trailing whitespace when comparing SQL', () => {
    const provider = new FilterCodeLensProvider();
    provider.setActiveSql(`  ${ARMOR_SQL}  `);

    expect(soleLens(provider.provideCodeLenses(makeDocument(`\n${ARMOR_SQL}\n`, '/scripts/armor.sql'))).command)
      .toBe('modbench.record.clearFilter');
  });

  it('offers to apply again once no filter is in force', () => {
    const provider = new FilterCodeLensProvider();
    provider.setActiveSql(ARMOR_SQL);
    provider.setActiveSql(null);

    expect(soleLens(provider.provideCodeLenses(makeDocument(ARMOR_SQL, '/scripts/armor.sql'))).command)
      .toBe('modbench.record.filter');
  });
});
