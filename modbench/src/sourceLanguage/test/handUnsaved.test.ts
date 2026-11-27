import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host, type FakeDocument } from './vscodeHost';
import { sourceLanguageOver } from './sourceLanguageOver';

const FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';
const OTHER = '/source/ModA/plugin-source/A.esp/Cells/Other.json';

function handing(...held: FakeDocument[]) {
  const { client } = sourceLanguageOver({ arrange: () => { host.holds(held); } });
  return () => client.calls.filter(({ method }) => method === 'handUnsavedDocument').map(({ args }) => args[0]);
}

describe('handing mEdit the unsaved plugin source', () => {
  it('hands a document already unsaved when it starts, and none that is saved', () => {
    expect(handing(document(FILE, 'typed'), document(OTHER, 'saved', { isDirty: false }))()).toEqual([{ path: FILE, text: 'typed', version: 1 }]);
  });

  it('hands a document as it is opened unsaved, and as each change makes a new text, at a higher version', () => {
    const handed = handing();
    const doc = document(FILE, 'first');
    host.open(doc);
    doc.text = 'second';
    host.change(doc);

    expect(handed()).toEqual([{ path: FILE, text: 'first', version: 1 }, { path: FILE, text: 'second', version: 2 }]);
  });

  it('reads only the document that changed, and hands nothing for a change that leaves the text as it was', () => {
    let bystanderReads = 0;
    const bystander = { ...document(OTHER, 'untouched'), getText: () => { bystanderReads += 1; return 'untouched'; } };
    const doc = document(FILE, 'first');
    const handed = handing(bystander, doc);
    const [readsBefore, before] = [bystanderReads, handed().length];

    host.change(doc);
    doc.text = 'second';
    host.change(doc);

    expect([handed().slice(before), bystanderReads]).toEqual([[{ path: FILE, text: 'second', version: 3 }], readsBefore]);
  });

  it.each([
    ['saved', (doc: FakeDocument) => { host.save(doc); }],
    ['reverted', (doc: FakeDocument) => { doc.isDirty = false; host.change(doc); }],
    ['closed unsaved', (doc: FakeDocument) => { host.close(doc); }],
  ])('hands the close of a document that is %s, once', (_how, end) => {
    const doc = document(FILE, 'typed');
    const handed = handing(doc);

    end(doc);
    host.change(doc);

    expect(handed().slice(1)).toEqual([{ path: FILE, closed: true }]);
  });

  it('hands nothing when the document of a child record closes while the file\'s holds the text, and the close when that one does', () => {
    const file = document(FILE, 'typed');
    const child = document(FILE, 'typed', { scheme: 'modbench-child-record' });
    const handed = handing(file, child);

    host.close(child);
    const afterChild = handed().slice(1);
    host.close(file);

    expect([afterChild, handed().slice(1)]).toEqual([[], [{ path: FILE, closed: true }]]);
  });

  it('holds back a document outside plugin source and a version-control document of plugin source', () => {
    expect(handing(document('/mods/ModA/readme.txt', 'typed'), document(FILE, 'typed', { scheme: 'git' }))()).toEqual([]);
  });
});
