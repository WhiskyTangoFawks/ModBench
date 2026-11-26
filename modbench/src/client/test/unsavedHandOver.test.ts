import { describe, it, expect } from 'vitest';
import type { BackendStatus, UnsavedDocumentChange, WriteRefused } from '../MEditClient';
import { createUnsavedHandOver, type UnsavedDocumentsWire } from '../unsavedHandOver';
import { settled } from '../../test/eventually';

const GUN = '/mod/plugin-source/A.esp/Gun.json';
const AXE = '/mod/plugin-source/A.esp/Axe.json';

function fakeWire(status: BackendStatus) {
  const statusListeners = new Set<(status: BackendStatus) => void>();
  const reopenListeners = new Set<() => void>();
  const put: string[] = [];
  let answer: (change: UnsavedDocumentChange) => Promise<WriteRefused | undefined> = () => Promise.resolve(undefined);
  const wire: UnsavedDocumentsWire = {
    status: () => status,
    onStatusChanged: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onReconnected: (listener) => { reopenListeners.add(listener); return () => reopenListeners.delete(listener); },
    put: (change, opened) => {
      put.push('closed' in change ? `${change.path} closed` : `${change.path}@${change.version}:${change.text}${opened ? ' opened' : ''}`);
      return answer(change);
    },
  };
  return {
    wire,
    put,
    answerWith: (next: (change: UnsavedDocumentChange) => Promise<WriteRefused | undefined>) => { answer = next; },
    becomes: (next: BackendStatus) => { status = next; for (const listener of statusListeners) listener(next); },
    reopens: () => { for (const listener of reopenListeners) listener(); },
  };
}

const typed = (text: string, version: number, path = GUN): UnsavedDocumentChange => ({ path, version, text });
const closed = (path = GUN): UnsavedDocumentChange => ({ path, closed: true });
const refused: WriteRefused = { refused: true, message: 'Not plugin source.' };
const refusing = () => Promise.resolve(refused);
const taking = () => Promise.resolve(undefined);

describe('handing mEdit an unsaved document', () => {
  it('hands the first change of a document as an open, and the ones after it as changes', async () => {
    const mEdit = fakeWire('running');
    const handOver = createUnsavedHandOver(mEdit.wire);

    handOver.hand(typed('first', 1));
    await handOver.sent();
    handOver.hand(typed('second', 2));
    await handOver.sent();

    expect(mEdit.put).toEqual([`${GUN}@1:first opened`, `${GUN}@2:second`]);
  });

  it('hands only the newest change of a document that waits behind the one in flight', async () => {
    const mEdit = fakeWire('running');
    let answerFirst!: () => void;
    mEdit.answerWith(() => new Promise((resolve) => { answerFirst = () => { resolve(undefined); }; }));
    const handOver = createUnsavedHandOver(mEdit.wire);

    handOver.hand(typed('first', 1));
    handOver.hand(typed('second', 2));
    handOver.hand(typed('third', 3));
    await settled(() => { expect(mEdit.put).toEqual([`${GUN}@1:first opened`]); });
    mEdit.answerWith(taking);
    answerFirst();
    await handOver.sent();

    expect(mEdit.put).toEqual([`${GUN}@1:first opened`, `${GUN}@3:third`]);
  });

  it('hands nothing while mEdit is not running, then each document still open once it runs', async () => {
    const mEdit = fakeWire('starting');
    const handOver = createUnsavedHandOver(mEdit.wire);

    handOver.hand(typed('first', 1));
    handOver.hand(typed('second', 2));
    handOver.hand(typed('other', 3, AXE));
    handOver.hand(closed(AXE));
    await handOver.sent();
    expect(mEdit.put).toEqual([]);

    mEdit.becomes('running');
    await handOver.sent();
    expect(mEdit.put).toEqual([`${GUN}@2:second opened`, `${AXE} closed`]);
  });

  it('hands each open document again, as an open, when the stream reopens onto a process that may hold none', async () => {
    const mEdit = fakeWire('running');
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.hand(typed('typed', 1));
    await handOver.sent();

    mEdit.reopens();
    await handOver.sent();

    expect(mEdit.put).toEqual([`${GUN}@1:typed opened`, `${GUN}@1:typed opened`]);
  });

  it('hands a document as an open when a refused open is handed again with a newer change', async () => {
    const mEdit = fakeWire('running');
    mEdit.answerWith(refusing);
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.hand(typed('first', 1));
    await handOver.sent();

    mEdit.answerWith(taking);
    handOver.hand(typed('second', 2));
    await handOver.sent();

    expect(mEdit.put).toEqual([`${GUN}@1:first opened`, `${GUN}@2:second opened`]);
  });
});

describe('a hand-over mEdit did not take', () => {
  const lost: [string, UnsavedDocumentChange, string][] = [
    ['change', typed('second', 2), `${GUN}@2:second`],
    ['close', closed(), `${GUN} closed`],
  ];

  it.each(lost)('is handed again with the next hand-over of any document: a refused %s', async (_what, change, asHanded) => {
    const mEdit = fakeWire('running');
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.hand(typed('first', 1));
    await handOver.sent();
    mEdit.answerWith(refusing);
    handOver.hand(change);
    await handOver.sent();
    mEdit.put.length = 0;
    mEdit.answerWith(taking);

    handOver.hand(typed('other', 3, AXE));
    await handOver.sent();

    expect(mEdit.put).toEqual([asHanded, `${AXE}@3:other opened`]);
  });

  it('is handed again when the stream reopens', async () => {
    const mEdit = fakeWire('running');
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.hand(typed('first', 1));
    await handOver.sent();
    mEdit.answerWith(refusing);
    handOver.hand(closed());
    await handOver.sent();
    mEdit.put.length = 0;
    mEdit.answerWith(taking);

    mEdit.reopens();
    await handOver.sent();

    expect(mEdit.put).toEqual([`${GUN} closed`]);
  });

  it('keeps its refusal told until that document is taken, whatever mEdit takes meanwhile', async () => {
    const mEdit = fakeWire('running');
    const told: (WriteRefused | undefined)[] = [];
    const handOver = createUnsavedHandOver(mEdit.wire);
    handOver.onSettled((failure) => { told.push(failure); });
    mEdit.answerWith((change) => (change.path === GUN ? Promise.resolve(refused) : Promise.resolve(undefined)));

    handOver.hand(typed('first', 1));
    await handOver.sent();
    handOver.hand(typed('other', 2, AXE));
    await handOver.sent();
    const toldAfterAnother = told.at(-1);
    mEdit.answerWith(taking);
    handOver.hand(typed('second', 3));
    await handOver.sent();

    expect([toldAfterAnother, told.at(-1)]).toEqual([refused, undefined]);
  });
});

describe('whether a hand-over is pending', () => {
  it('is true from a hand-over until it has answered', async () => {
    const mEdit = fakeWire('running');
    let answer!: () => void;
    mEdit.answerWith(() => new Promise((resolve) => { answer = () => { resolve(undefined); }; }));
    const handOver = createUnsavedHandOver(mEdit.wire);
    expect(handOver.pending()).toBe(false);

    handOver.hand(typed('first', 1));
    expect(handOver.pending()).toBe(true);

    await settled(() => { expect(mEdit.put).toHaveLength(1); });
    answer();
    await settled(() => { expect(handOver.pending()).toBe(false); });
  });
});
