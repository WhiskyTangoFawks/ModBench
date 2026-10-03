import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { recordUri, formKeyOfRecordUri, RECORD_EDITOR_VIEW_TYPE } from '../recordUri';

describe('recordUri / formKeyOfRecordUri', () => {
  it('round-trips a FormKey through its own URI', () => {
    const uri = recordUri({ formKey: 'Fallout4.esm:000001' });
    expect(formKeyOfRecordUri(uri)).toBe('Fallout4.esm:000001');
  });

  it('gives two different FormKeys two different URIs', () => {
    expect(recordUri({ formKey: 'Fallout4.esm:000001' }).path).not.toBe(recordUri({ formKey: 'Fallout4.esm:000002' }).path);
  });

  it('gives the same FormKey the same URI on every call', () => {
    expect(recordUri({ formKey: 'Fallout4.esm:000001' })).toEqual(recordUri({ formKey: 'Fallout4.esm:000001' }));
  });

  it('survives a FormKey containing "/"', () => {
    const uri = recordUri({ formKey: 'Weird/Plugin.esp:000001' });
    expect(formKeyOfRecordUri(uri)).toBe('Weird/Plugin.esp:000001');
  });

  it('gives one header FormKey from two origins two URIs, since a filename alone names no one plugin', () => {
    const header = '000000:MyPatch.esp';
    expect(recordUri({ formKey: header, origin: 'ModA' })).not.toEqual(recordUri({ formKey: header, origin: 'ModB' }));
  });

  it('reads the same FormKey back from a header address, whatever its origin', () => {
    expect(formKeyOfRecordUri(recordUri({ formKey: '000000:MyPatch.esp', origin: 'ModA' }))).toBe('000000:MyPatch.esp');
  });

  it('names the registered custom editor viewType', () => {
    expect(RECORD_EDITOR_VIEW_TYPE).toBe('modbench.record');
  });
});
