import { describe, it, expect } from 'vitest';
import { recordTitle } from '../recordTitle';

const FORM_KEY = '000801:A.esp';

describe('recordTitle (editor.md, Opening, story 5)', () => {
  it('is the EditorID', () => {
    expect(recordTitle(FORM_KEY, [{ editorId: 'Gun', isWinner: true }])).toBe('Gun');
  });

  it('reads the winner\'s EditorID, not the first column\'s', () => {
    expect(recordTitle(FORM_KEY, [{ editorId: 'Old', isWinner: false }, { editorId: 'New', isWinner: true }])).toBe('New');
  });

  it('is the FormKey when the record has no EditorID', () => {
    expect(recordTitle(FORM_KEY, [{ editorId: null, isWinner: true }])).toBe(FORM_KEY);
  });

  it('is the FormKey before any read has answered', () => {
    expect(recordTitle(FORM_KEY, undefined)).toBe(FORM_KEY);
  });

  it('is the plugin\'s file name for a plugin header', () => {
    expect(recordTitle('000000:MyPatch.esp', [{ editorId: null, isWinner: true }])).toBe('MyPatch.esp');
  });
});
