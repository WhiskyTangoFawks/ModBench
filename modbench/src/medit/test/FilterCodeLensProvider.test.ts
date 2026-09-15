import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { FilterCodeLensProvider } from '../FilterCodeLensProvider';
import { fakeUri } from '../../test/vscodeMock';
import { present } from '../../present';

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
function makeDocument(text: string, fsPath: string): vscode.TextDocument {
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

// Reads the command id off the sole lens a `provideCodeLenses` call returned.
function soleLensCommand(lenses: readonly vscode.CodeLens[]): string {
  const lens = present(lenses[0], 'the sole code lens returned');
  return present(lens.command, "the lens's command").command;
}

describe('FilterCodeLensProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('provideCodeLenses', () => {
    it('returns empty array for files outside scriptsPath', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      const doc = makeDocument('SELECT form_key FROM "npc_"', '/some/other/file.sql');

      const lenses = provider.provideCodeLenses(doc);

      expect(lenses).toHaveLength(0);
    });

    it('returns Apply lens for sql file under scriptsPath when no filter is active', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      const doc = makeDocument(
        'SELECT form_key FROM "npc_"',
        '/home/user/.medit/scripts/my-filter.sql',
      );

      const lenses = provider.provideCodeLenses(doc);

      expect(lenses).toHaveLength(1);
      expect(soleLensCommand(lenses)).toBe('modbench.setFilterFromDocument');
    });

    it('returns Clear lens when the document sql matches the active filter', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      provider.setActiveSql('SELECT form_key FROM "npc_"');
      const doc = makeDocument(
        'SELECT form_key FROM "npc_"',
        '/home/user/.medit/scripts/my-filter.sql',
      );

      const lenses = provider.provideCodeLenses(doc);

      expect(lenses).toHaveLength(1);
      expect(soleLensCommand(lenses)).toBe('modbench.clearFilter');
    });

    it('returns Apply lens when document sql differs from active filter', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      provider.setActiveSql('SELECT form_key FROM "weap"');
      const doc = makeDocument(
        'SELECT form_key FROM "npc_"',
        '/home/user/.medit/scripts/my-filter.sql',
      );

      const lenses = provider.provideCodeLenses(doc);

      expect(lenses).toHaveLength(1);
      expect(soleLensCommand(lenses)).toBe('modbench.setFilterFromDocument');
    });

    it('ignores leading/trailing whitespace when comparing sql', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      provider.setActiveSql('  SELECT form_key FROM "npc_"  ');
      const doc = makeDocument(
        '\nSELECT form_key FROM "npc_"\n',
        '/home/user/.medit/scripts/my-filter.sql',
      );

      const lenses = provider.provideCodeLenses(doc);

      expect(soleLensCommand(lenses)).toBe('modbench.clearFilter');
    });
  });

  describe('setActiveSql', () => {
    it('setActiveSql(null) causes Apply lens to be shown', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      provider.setActiveSql('SELECT form_key FROM "npc_"');
      provider.setActiveSql(null);
      const doc = makeDocument(
        'SELECT form_key FROM "npc_"',
        '/home/user/.medit/scripts/my-filter.sql',
      );

      const lenses = provider.provideCodeLenses(doc);

      expect(soleLensCommand(lenses)).toBe('modbench.setFilterFromDocument');
    });
  });
});
