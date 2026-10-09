import { describe, it, expect } from 'vitest';
import type { BackendStatus, UnsavedDocument } from '../MEditClient';
import { createUnsavedHandOver, type UnsavedDocumentsWire } from '../unsavedHandOver';

function fakeWire(status: BackendStatus) {
  const statusListeners = new Set<(status: BackendStatus) => void>();
  const reopenListeners = new Set<() => void>();
  const put: string[] = [];
  let answer: () => Promise<void> = () => Promise.resolve();
  const wire: UnsavedDocumentsWire = {
    status: () => status,
    onStatusChanged: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onReconnected: (listener) => { reopenListeners.add(listener); return () => reopenListeners.delete(listener); },
    put: (documents) => { put.push(documents.map(({ text }) => text).join()); return answer(); },
  };
  return {
    wire,
    put,
    answerWith: (next: () => Promise<void>) => { answer = next; },
    becomes: (next: BackendStatus) => { status = next; for (const listener of statusListeners) listener(next); },
    reopens: () => { for (const listener of reopenListeners) listener(); },
  };
}

const typed = (text: string): UnsavedDocument[] => [{ path: '/mod/plugin-source/A.esp/Gun.json', text }];

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('handing mEdit the unsaved documents', () => {
  it('puts each hand-over at once while mEdit runs, the next only once the one before has answered', async () => {
    const mEdit = fakeWire('running');
    let answerFirst!: () => void;
    mEdit.answerWith(() => new Promise((resolve) => { answerFirst = resolve; }));
    const hand = createUnsavedHandOver(mEdit.wire, () => {});

    hand(typed('first'));
    hand(typed('second'));
    await settled();
    expect(mEdit.put).toEqual(['first']);

    answerFirst();
    await settled();
    expect(mEdit.put).toEqual(['first', 'second']);
  });

  it('puts nothing while mEdit is not running, then the newest once it runs', async () => {
    const mEdit = fakeWire('starting');
    const hand = createUnsavedHandOver(mEdit.wire, () => {});

    hand(typed('first'));
    hand(typed('second'));
    await settled();
    expect(mEdit.put).toEqual([]);

    mEdit.becomes('running');
    await settled();
    expect(mEdit.put).toEqual(['second']);
  });

  it('puts the newest again when the stream reopens, onto a process that may hold none', async () => {
    const mEdit = fakeWire('running');
    const hand = createUnsavedHandOver(mEdit.wire, () => {});
    hand(typed('typed'));

    mEdit.reopens();
    await settled();

    expect(mEdit.put).toEqual(['typed', 'typed']);
  });

  it('says why a put failed, and still puts the next', async () => {
    const mEdit = fakeWire('running');
    const said: string[] = [];
    mEdit.answerWith(() => Promise.reject(new Error('connection reset')));
    const hand = createUnsavedHandOver(mEdit.wire, (line) => { said.push(line); });

    hand(typed('first'));
    hand(typed('second'));
    await settled();

    expect(mEdit.put).toEqual(['first', 'second']);
    expect(said).toEqual([expect.stringContaining('connection reset'), expect.stringContaining('connection reset')]);
  });
});
