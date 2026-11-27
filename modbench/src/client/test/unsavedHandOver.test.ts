import { describe, it, expect } from 'vitest';
import type { UnsavedDocumentChange, WriteRefused } from '../MEditClient';
import { settled } from '../../test/eventually';
import { answered } from './healthAnswer';
import { fakeMEdit, jsonResponse } from './fakeMEdit';

const GUN = '/mod/plugin-source/A.esp/Gun.json';
const AXE = '/mod/plugin-source/A.esp/Axe.json';

const typed = (text: string, version: number, path = GUN): UnsavedDocumentChange => ({ path, version, text });
const asOpen = (text: string, version: number, path = GUN) => ({ path, text, version, opened: true });
const asChange = (text: string, version: number, path = GUN) => ({ path, text, version, opened: false });
const asClose = (path = GUN) => ({ path, closed: true });
const closed = (path = GUN): UnsavedDocumentChange => ({ path, closed: true });
const refused: WriteRefused = { refused: true, message: 'mEdit could not take the unsaved plugin source — Not plugin source.' };
/** Answers a hand-over from the path it closes, or the body it puts. */
type Answer = (handed: string) => Promise<Response>;
const refusing: Answer = () => Promise.resolve(jsonResponse(400, { title: 'Bad Request', status: 400, detail: 'Not plugin source.' }));
const taking: Answer = () => Promise.resolve(new Response(null, { status: 204 }));

/** mEdit as the hand-over meets it: each hand-over it answers as `answer` says, and how each was handed. */
function handingOver(health: () => Promise<boolean> = () => Promise.resolve(true)) {
  const put: unknown[] = [];
  let answer = taking;
  const mEdit = fakeMEdit({
    backend: { checkHealth: async () => answered(await health()) },
    routes: [['/unsaved-document', async (request) => {
      const path = new URL(request.url).searchParams.get('path');
      const body = await request.text();
      put.push(path === null ? JSON.parse(body) : { path, closed: true });
      return answer(path ?? body);
    }]],
  });
  const told: (WriteRefused | undefined)[] = [];
  mEdit.client.onUnsavedHandOver((failure) => { told.push(failure); });
  return {
    ...mEdit, put, told,
    answerWith: (next: Answer) => { answer = next; },
    /** Hands each change, and settles once mEdit has answered as many hand-overs as are `answered` in all. */
    hand: async (answeredInAll: number, ...changes: UnsavedDocumentChange[]) => {
      for (const change of changes) mEdit.client.handUnsavedDocument(change);
      await settled(() => { expect(told).toHaveLength(answeredInAll); });
    },
  };
}

async function runningHandOver() {
  const mEdit = handingOver();
  await mEdit.start();
  return mEdit;
}

describe('handing mEdit an unsaved document', () => {
  it('hands the first change of a document as an open, and the ones after it as changes', async () => {
    const mEdit = await runningHandOver();

    await mEdit.hand(1, typed('first', 1));
    await mEdit.hand(2, typed('second', 2));

    expect(mEdit.put).toEqual([asOpen('first', 1), asChange('second', 2)]);
  });

  it('hands only the newest change of a document that waits behind the one in flight', async () => {
    const mEdit = await runningHandOver();
    let answerFirst!: () => void;
    mEdit.answerWith(() => new Promise((resolve) => { answerFirst = () => { resolve(new Response(null, { status: 204 })); }; }));

    mEdit.client.handUnsavedDocument(typed('first', 1));
    mEdit.client.handUnsavedDocument(typed('second', 2));
    mEdit.client.handUnsavedDocument(typed('third', 3));
    await settled(() => { expect(mEdit.put).toEqual([asOpen('first', 1)]); });
    mEdit.answerWith(taking);
    answerFirst();
    await settled(() => { expect(mEdit.told).toHaveLength(2); });

    expect(mEdit.put).toEqual([asOpen('first', 1), asChange('third', 3)]);
  });

  it('hands nothing while mEdit is not running, then each document still open once it runs', async () => {
    let comeUp!: () => void;
    const up = new Promise<boolean>((resolve) => { comeUp = () => { resolve(true); }; });
    const mEdit = handingOver(() => up);
    const started = mEdit.start();
    await settled(() => { expect(mEdit.client.status).toBe('starting'); });

    mEdit.client.handUnsavedDocument(typed('first', 1));
    mEdit.client.handUnsavedDocument(typed('second', 2));
    mEdit.client.handUnsavedDocument(typed('other', 3, AXE));
    mEdit.client.handUnsavedDocument(closed(AXE));
    comeUp();
    await started;
    await settled(() => { expect(mEdit.told).toHaveLength(2); });

    expect(mEdit.put).toEqual([asOpen('second', 2), asClose(AXE)]);
  });

  it('hands each open document again, as an open, when the stream reopens onto a process that may hold none', async () => {
    const mEdit = await runningHandOver();
    await mEdit.hand(1, typed('typed', 1));

    await mEdit.reopen();
    await settled(() => { expect(mEdit.told).toHaveLength(2); });

    expect(mEdit.put).toEqual([asOpen('typed', 1), asOpen('typed', 1)]);
  });

  it('hands a document as an open when a refused open is handed again with a newer change', async () => {
    const mEdit = await runningHandOver();
    mEdit.answerWith(refusing);
    await mEdit.hand(1, typed('first', 1));

    mEdit.answerWith(taking);
    await mEdit.hand(2, typed('second', 2));

    expect(mEdit.put).toEqual([asOpen('first', 1), asOpen('second', 2)]);
  });
});

describe('a hand-over mEdit did not take', () => {
  const lost: [string, UnsavedDocumentChange, unknown][] = [
    ['change', typed('second', 2), asChange('second', 2)],
    ['close', closed(), asClose()],
  ];

  it.each(lost)('is handed again with the next hand-over of any document: a refused %s', async (_what, change, asHanded) => {
    const mEdit = await runningHandOver();
    await mEdit.hand(1, typed('first', 1));
    mEdit.answerWith(refusing);
    await mEdit.hand(2, change);
    mEdit.put.length = 0;
    mEdit.answerWith(taking);

    await mEdit.hand(4, typed('other', 3, AXE));

    expect(mEdit.put).toEqual([asHanded, asOpen('other', 3, AXE)]);
  });

  it('is handed again when the stream reopens', async () => {
    const mEdit = await runningHandOver();
    await mEdit.hand(1, typed('first', 1));
    mEdit.answerWith(refusing);
    await mEdit.hand(2, closed());
    mEdit.put.length = 0;
    mEdit.answerWith(taking);

    await mEdit.reopen();
    await settled(() => { expect(mEdit.told).toHaveLength(3); });

    expect(mEdit.put).toEqual([asClose()]);
  });

  it('keeps its refusal told until that document is taken, whatever mEdit takes meanwhile', async () => {
    const mEdit = await runningHandOver();
    mEdit.answerWith((handed) => (handed.includes(GUN) ? refusing(handed) : taking(handed)));

    await mEdit.hand(1, typed('first', 1));
    await mEdit.hand(3, typed('other', 2, AXE));
    const toldAfterAnother = mEdit.told.at(-1);
    mEdit.answerWith(taking);
    await mEdit.hand(4, typed('second', 3));

    expect([toldAfterAnother, mEdit.told.at(-1)]).toEqual([refused, undefined]);
  });
});
