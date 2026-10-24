import { describe, it, expect, vi } from 'vitest';
import type { BackendStatus, UnsavedDocument } from '../MEditClient';
import { createUnsavedHandOver, type UnsavedDocumentsWire } from '../unsavedHandOver';
import type { ReadFailed } from '../../wire/readFailed';

function fakeWire(status: BackendStatus) {
  const statusListeners = new Set<(status: BackendStatus) => void>();
  const reopenListeners = new Set<() => void>();
  const put: string[] = [];
  let answer: () => Promise<ReadFailed | undefined> = () => Promise.resolve(undefined);
  const wire: UnsavedDocumentsWire = {
    status: () => status,
    onStatusChanged: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onReconnected: (listener) => { reopenListeners.add(listener); return () => reopenListeners.delete(listener); },
    put: (documents) => { put.push(documents.map(({ text }) => text).join()); return answer(); },
  };
  return {
    wire,
    put,
    answerWith: (next: () => Promise<ReadFailed | undefined>) => { answer = next; },
    becomes: (next: BackendStatus) => { status = next; for (const listener of statusListeners) listener(next); },
    reopens: () => { for (const listener of reopenListeners) listener(); },
  };
}

const typed = (text: string): UnsavedDocument[] => [{ path: '/mod/plugin-source/A.esp/Gun.json', text }];

describe('handing mEdit the unsaved documents', () => {
  it('puts each hand-over at once while mEdit runs, the next only once the one before has answered', async () => {
    const mEdit = fakeWire('running');
    let answerFirst!: () => void;
    mEdit.answerWith(() => new Promise((resolve) => { answerFirst = () => { resolve(undefined); }; }));
    const hand = createUnsavedHandOver(mEdit.wire).hand;

    hand(typed('first'));
    hand(typed('second'));
    await vi.waitFor(() => { expect(mEdit.put).toEqual(['first']); });

    answerFirst();
    await vi.waitFor(() => { expect(mEdit.put).toEqual(['first', 'second']); });
  });

  it('puts nothing while mEdit is not running, then the newest once it runs', async () => {
    const mEdit = fakeWire('starting');
    const handOver = createUnsavedHandOver(mEdit.wire);

    handOver.hand(typed('first'));
    handOver.hand(typed('second'));
    await handOver.sent();
    expect(mEdit.put).toEqual([]);

    mEdit.becomes('running');
    await handOver.sent();
    expect(mEdit.put).toEqual(['second']);
  });

  it('puts the newest again when the stream reopens, onto a process that may hold none', async () => {
    const mEdit = fakeWire('running');
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.hand(typed('typed'));

    mEdit.reopens();
    await handOver.sent();

    expect(mEdit.put).toEqual(['typed', 'typed']);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('socket hang up'))],
    ['answers unreachable', () => Promise.resolve({ failed: 'unreachable' } as const)],
  ])('answers a put that %s as unreachable, and still puts the next', async (_, firstAnswer) => {
    const mEdit = fakeWire('running');
    const answers: (ReadFailed | undefined)[] = [];
    mEdit.answerWith(firstAnswer);
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.onSettled((failure) => { answers.push(failure); });

    handOver.hand(typed('first'));
    await handOver.sent();
    mEdit.answerWith(() => Promise.resolve(undefined));
    handOver.hand(typed('second'));
    await handOver.sent();

    expect(mEdit.put).toEqual(['first', 'second']);
    expect(answers).toEqual([{ failed: 'unreachable' }, undefined]);
  });
});
