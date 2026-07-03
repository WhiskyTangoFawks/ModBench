import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilterCodeLensProvider } from '../FilterCodeLensProvider';

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

function makeDocument(text: string, fsPath: string) {
  return {
    getText: () => text,
    uri: { fsPath },
    lineAt: () => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }),
    lineCount: 1,
  } as any;
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
      expect((lenses[0] as any).command.command).toBe('modbench.setFilterFromDocument');
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
      expect((lenses[0] as any).command.command).toBe('modbench.clearFilter');
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
      expect((lenses[0] as any).command.command).toBe('modbench.setFilterFromDocument');
    });

    it('ignores leading/trailing whitespace when comparing sql', () => {
      const provider = new FilterCodeLensProvider('/home/user/.medit/scripts');
      provider.setActiveSql('  SELECT form_key FROM "npc_"  ');
      const doc = makeDocument(
        '\nSELECT form_key FROM "npc_"\n',
        '/home/user/.medit/scripts/my-filter.sql',
      );

      const lenses = provider.provideCodeLenses(doc);

      expect((lenses[0] as any).command.command).toBe('modbench.clearFilter');
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

      expect((lenses[0] as any).command.command).toBe('modbench.setFilterFromDocument');
    });
  });
});
