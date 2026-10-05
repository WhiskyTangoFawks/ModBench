import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { recordResourceUri, parseRecordResourceUri } from '../recordResourceUri';
import { fakeUri } from '../../test/vscodeMock';

describe('recordResourceUri / parseRecordResourceUri', () => {
  it('round-trips a plugin\'s copy of a record through the medit-record: scheme', () => {
    const uri = recordResourceUri({ name: 'Fallout4.esm', origin: 'ModA' }, '000001:Fallout4.esm');
    expect(uri.scheme).toBe('medit-record');

    const parsed = parseRecordResourceUri(uri);
    expect(parsed).toEqual({ plugin: { name: 'Fallout4.esm', origin: 'ModA' }, formKey: '000001:Fallout4.esm' });
  });

  it('survives identity components that themselves contain "/" (percent-encoded per segment)', () => {
    const uri = recordResourceUri({ name: 'Weird/Plugin.esp', origin: 'Mod/Folder' }, '01:Weird/Plugin.esp');
    const parsed = parseRecordResourceUri(uri);
    expect(parsed).toEqual({ plugin: { name: 'Weird/Plugin.esp', origin: 'Mod/Folder' }, formKey: '01:Weird/Plugin.esp' });
  });

  it('returns undefined for a URI outside the medit-record: scheme', () => {
    expect(parseRecordResourceUri(fakeUri('/tmp/x'))).toBeUndefined();
  });
});
