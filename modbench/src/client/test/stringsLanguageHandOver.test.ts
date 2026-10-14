import { describe, it, expect } from 'vitest';
import type { BackendStatus } from '../MEditClient';
import { createStringsLanguageHandOver, type StringsLanguageWire } from '../stringsLanguageHandOver';

function fakeWire(status: BackendStatus) {
  const statusListeners = new Set<(status: BackendStatus) => void>();
  const reopenListeners = new Set<() => void>();
  const put: string[] = [];
  const wire: StringsLanguageWire = {
    status: () => status,
    onStatusChanged: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onReconnected: (listener) => { reopenListeners.add(listener); return () => reopenListeners.delete(listener); },
    put: (language) => { put.push(language); return Promise.resolve(); },
  };
  return {
    wire,
    put,
    becomes: (next: BackendStatus) => { status = next; for (const listener of statusListeners) listener(next); },
    reopens: () => { for (const listener of reopenListeners) listener(); },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('handing mEdit the strings language', () => {
  it('puts the language at once while mEdit runs', async () => {
    const mEdit = fakeWire('running');

    createStringsLanguageHandOver(mEdit.wire).hand('French');
    await settled();

    expect(mEdit.put).toEqual(['French']);
  });

  it('holds the language until mEdit runs, then puts the newest', async () => {
    const mEdit = fakeWire('starting');
    const handOver = createStringsLanguageHandOver(mEdit.wire);

    handOver.hand('French');
    handOver.hand('German');
    mEdit.becomes('running');
    await settled();

    expect(mEdit.put).toEqual(['German']);
  });

  it('puts it again when the stream reopens, since the process behind it may hold none', async () => {
    const mEdit = fakeWire('running');
    createStringsLanguageHandOver(mEdit.wire).hand('French');

    mEdit.reopens();
    await settled();

    expect(mEdit.put).toEqual(['French', 'French']);
  });

  it('puts nothing before a language is handed, so mEdit keeps its English', async () => {
    const mEdit = fakeWire('running');
    createStringsLanguageHandOver(mEdit.wire);

    mEdit.becomes('running');
    mEdit.reopens();
    await settled();

    expect(mEdit.put).toEqual([]);
  });
});
