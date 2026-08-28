import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { recordResourceUri, parseRecordResourceUri } from '../recordResourceUri';

describe('recordResourceUri / parseRecordResourceUri (#428)', () => {
  it('round-trips (plugin, origin, formKey) through the medit-record: scheme', () => {
    const uri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm');
    expect(uri.scheme).toBe('medit-record');

    const parsed = parseRecordResourceUri(uri);
    expect(parsed).toEqual({
      plugin: 'Fallout4.esm', origin: 'ModA', formKey: '000001:Fallout4.esm', fromConflictsNode: false,
    });
  });

  it('round-trips an undefined origin (an ordinary load-order plugin) as an empty segment', () => {
    const uri = recordResourceUri('Fallout4.esm', undefined, '000001:Fallout4.esm');
    const parsed = parseRecordResourceUri(uri);
    expect(parsed).toEqual({ plugin: 'Fallout4.esm', origin: '', formKey: '000001:Fallout4.esm', fromConflictsNode: false });
  });

  it('survives identity components that themselves contain "/" (percent-encoded per segment)', () => {
    const uri = recordResourceUri('Weird/Plugin.esp', 'Mod/Folder', '01:Weird/Plugin.esp');
    const parsed = parseRecordResourceUri(uri);
    expect(parsed).toEqual({
      plugin: 'Weird/Plugin.esp', origin: 'Mod/Folder', formKey: '01:Weird/Plugin.esp', fromConflictsNode: false,
    });
  });

  it('returns undefined for a URI outside the medit-record: scheme', () => {
    expect(parseRecordResourceUri({ scheme: 'file', path: '/tmp/x' } as never)).toBeUndefined();
  });

  // #364 review finding: the marker that lets RecordDecorationProvider scope the conflict badge
  // to the Conflicts node's own rows — see recordResourceUri.ts's own doc comment.
  it('carries fromConflictsNode through the query string when set', () => {
    const uri = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', true);
    const parsed = parseRecordResourceUri(uri);
    expect(parsed?.fromConflictsNode).toBe(true);
  });

  it('two URIs for the same identity differ only in fromConflictsNode — never the same URI', () => {
    const ordinary = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', false);
    const conflicts = recordResourceUri('Fallout4.esm', 'ModA', '000001:Fallout4.esm', true);
    expect(ordinary.path).toBe(conflicts.path); // same identity
    expect(ordinary.query).not.toBe(conflicts.query); // different location marker
    expect(parseRecordResourceUri(ordinary)?.fromConflictsNode).toBe(false);
    expect(parseRecordResourceUri(conflicts)?.fromConflictsNode).toBe(true);
  });
});
