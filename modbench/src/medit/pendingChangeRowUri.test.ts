import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) => ({
      scheme: opts.scheme,
      path: opts.path,
      query: opts.query ?? '',
    }),
  },
}));

import { pluginRowUri, recordRowUri, parseRowIdentity, PENDING_PLUGIN_SCHEME, PENDING_RECORD_SCHEME } from './pendingChangeRowUri';

describe('pendingChangeRowUri', () => {
  it('round-trips a plugin row', () => {
    const uri = pluginRowUri('MyPatch.esp');
    expect(parseRowIdentity(uri)).toEqual({ kind: 'plugin', plugin: 'MyPatch.esp' });
  });

  // formKey contains ':' — the encoding must survive it through the query string.
  it('round-trips a record row without an origin', () => {
    const uri = recordRowUri('MyPatch.esp', '001234:MyPatch.esp');
    expect(parseRowIdentity(uri)).toEqual({ kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp', origin: undefined });
  });

  it('round-trips a record row with an origin (a shadowed copy)', () => {
    const uri = recordRowUri('Foo.esp', '001234:Foo.esp', 'SomeMod');
    expect(parseRowIdentity(uri)).toEqual({ kind: 'record', plugin: 'Foo.esp', formKey: '001234:Foo.esp', origin: 'SomeMod' });
  });

  it('undefined for a URI from an unrelated scheme', () => {
    expect(parseRowIdentity({ scheme: 'file', path: '/some/path', query: '' })).toBeUndefined();
  });

  it('the two schemes are distinct constants', () => {
    expect(PENDING_PLUGIN_SCHEME).not.toBe(PENDING_RECORD_SCHEME);
  });

  // #331 review: not a bug (encodeURIComponent/URLSearchParams already handle every one of
  // these correctly) but an unpinned correctness property in exactly the component where getting
  // it wrong misattributes a decoration from one row to another — a plugin filename or origin is
  // free-text a mod author chooses, not a name this codebase controls the character set of.
  it('round-trips a plugin filename containing a space, &, and %', () => {
    const uri = pluginRowUri('My Mod & Patch%20.esp');
    expect(parseRowIdentity(uri)).toEqual({ kind: 'plugin', plugin: 'My Mod & Patch%20.esp' });
  });

  it('round-trips a record row whose plugin filename contains a space, &, and %', () => {
    const uri = recordRowUri('My Mod & Patch%20.esp', '001234:My Mod & Patch%20.esp');
    expect(parseRowIdentity(uri)).toEqual({
      kind: 'record', plugin: 'My Mod & Patch%20.esp', formKey: '001234:My Mod & Patch%20.esp', origin: undefined,
    });
  });

  it('round-trips an origin containing a space and &', () => {
    const uri = recordRowUri('Foo.esp', '001234:Foo.esp', 'Some Mod & Co');
    expect(parseRowIdentity(uri)).toEqual({ kind: 'record', plugin: 'Foo.esp', formKey: '001234:Foo.esp', origin: 'Some Mod & Co' });
  });

  // Every hostile case above, together, on the same URI — proves the query string's own
  // ampersand-as-separator can't be confused with a literal '&' inside either value once both
  // are present at once, not just in isolation.
  it('round-trips plugin, formKey and origin together, each carrying its own space/&/%', () => {
    const uri = recordRowUri('My Mod & Co%20.esp', '001234:My Mod & Co%20.esp', 'Another Mod & Sons');
    expect(parseRowIdentity(uri)).toEqual({
      kind: 'record',
      plugin: 'My Mod & Co%20.esp',
      formKey: '001234:My Mod & Co%20.esp',
      origin: 'Another Mod & Sons',
    });
  });
});
