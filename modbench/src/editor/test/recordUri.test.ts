import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { recordUri, recordTabAddressOf, formKeyOf, RECORD_EDITOR_VIEW_TYPE } from '../recordUri';

describe('a record tab\'s address', () => {
  it('round-trips a FormKey through its own URI', () => {
    expect(recordTabAddressOf(recordUri({ formKey: 'Fallout4.esm:000001' }))).toEqual({ formKey: 'Fallout4.esm:000001' });
  });

  it('gives two different FormKeys two different URIs', () => {
    expect(recordUri({ formKey: 'Fallout4.esm:000001' }).path).not.toBe(recordUri({ formKey: 'Fallout4.esm:000002' }).path);
  });

  it('gives the same FormKey the same URI on every call', () => {
    expect(recordUri({ formKey: 'Fallout4.esm:000001' })).toEqual(recordUri({ formKey: 'Fallout4.esm:000001' }));
  });

  it('survives a FormKey containing "/"', () => {
    expect(recordTabAddressOf(recordUri({ formKey: 'Weird/Plugin.esp:000001' }))).toEqual({ formKey: 'Weird/Plugin.esp:000001' });
  });

  it('round-trips a Plugin Header record\'s plugin address through its own URI', () => {
    const header = { name: 'Mod/Patch.esp', origin: 'Mods/A' };
    expect(recordTabAddressOf(recordUri({ header }))).toEqual({ header });
  });

  it('gives the headers of two plugins that share a filename two URIs', () => {
    expect(recordUri({ header: { name: 'MyPatch.esp', origin: 'ModA' } }))
      .not.toEqual(recordUri({ header: { name: 'MyPatch.esp', origin: 'ModB' } }));
  });

  it('asks mEdit for a header at the FormKey mEdit indexes it at, and for a record at its own FormKey', () => {
    expect(formKeyOf({ header: { name: 'MyPatch.esp', origin: 'ModA' } })).toBe('000000:MyPatch.esp');
    expect(formKeyOf({ formKey: '000800:MyPatch.esp' })).toBe('000800:MyPatch.esp');
  });

  it('names the registered custom editor viewType', () => {
    expect(RECORD_EDITOR_VIEW_TYPE).toBe('modbench.record');
  });
});
