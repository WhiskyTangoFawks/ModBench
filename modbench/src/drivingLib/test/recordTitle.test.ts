import { describe, it, expect } from 'vitest';
import { recordTitle } from '../recordTitle';

const FORM_KEY = '000801:A.esp';
const OLD = { plugin: 'A.esp', origin: 'ModA', editorId: 'Old', isWinner: false };
const NEW = { plugin: 'B.esp', origin: 'ModB', editorId: 'New', isWinner: true };
const UNNAMED = { plugin: 'A.esp', origin: 'ModA', editorId: null, isWinner: true };

describe('recordTitle (editor.md, Opening, story 5)', () => {
  it.each([
    ['the EditorID', FORM_KEY, [{ ...UNNAMED, editorId: 'Gun' }], undefined, 'Gun'],
    ['the winner\'s EditorID, not the first column\'s', FORM_KEY, [OLD, NEW], undefined, 'New'],
    ['the opened copy\'s EditorID, for a tab of one copy, when an override renames it', FORM_KEY, [OLD, NEW], { name: 'A.esp', origin: 'ModA' }, 'Old'],
    ['the FormKey when the record has no EditorID', FORM_KEY, [UNNAMED], undefined, FORM_KEY],
    ['the FormKey before any read has answered', FORM_KEY, undefined, undefined, FORM_KEY],
    ['the plugin\'s file name for a plugin header', '000000:MyPatch.esp', [UNNAMED], undefined, 'MyPatch.esp'],
  ])('is %s', (_, formKey, columns, copy, title) => {
    expect(recordTitle(formKey, columns, copy)).toBe(title);
  });
});
