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
    const uri = recordUri('Fallout4.esm:000001');
    expect(formKeyOfRecordUri(uri)).toBe('Fallout4.esm:000001');
  });

  it('gives two different FormKeys two different URIs', () => {
    expect(recordUri('Fallout4.esm:000001').path).not.toBe(recordUri('Fallout4.esm:000002').path);
  });

  it('gives the same FormKey the same URI on every call', () => {
    expect(recordUri('Fallout4.esm:000001')).toEqual(recordUri('Fallout4.esm:000001'));
  });

  it('survives a FormKey containing "/"', () => {
    const uri = recordUri('Weird/Plugin.esp:000001');
    expect(formKeyOfRecordUri(uri)).toBe('Weird/Plugin.esp:000001');
  });

  it('reads back undefined for the no-record-yet picker address', () => {
    expect(formKeyOfRecordUri(recordUri(undefined))).toBeUndefined();
  });

  it('gives the picker address its own URI, distinct from any FormKey', () => {
    expect(recordUri(undefined).path).not.toBe(recordUri('Fallout4.esm:000001').path);
  });

  it('names the registered custom editor viewType', () => {
    expect(RECORD_EDITOR_VIEW_TYPE).toBe('modbench.record');
  });
});
