import { describe, it, expect } from 'vitest';
import { recordTitle } from '../recordTitle';

const FORM_KEY = '000801:A.esp';
const OLD = { plugin: 'A.esp', origin: 'ModA', editorId: 'Old', isWinner: false };
const NEW = { plugin: 'B.esp', origin: 'ModB', editorId: 'New', isWinner: true };

describe('recordTitle (editor.md, Opening, story 5)', () => {
  it('is the EditorID', () => {
    expect(recordTitle(FORM_KEY, [{ plugin: 'A.esp', origin: 'ModA', editorId: 'Gun', isWinner: true }])).toBe('Gun');
  });

  it('reads the winner\'s EditorID, not the first column\'s', () => {
    expect(recordTitle(FORM_KEY, [OLD, NEW])).toBe('New');
  });

  it('is the opened copy\'s EditorID, for a tab of one copy, when an override renames it', () => {
    expect(recordTitle(FORM_KEY, [OLD, NEW], { name: 'A.esp', origin: 'ModA' })).toBe('Old');
  });

  it('is the FormKey when the record has no EditorID', () => {
    expect(recordTitle(FORM_KEY, [{ plugin: 'A.esp', origin: 'ModA', editorId: null, isWinner: true }])).toBe(FORM_KEY);
  });

  it('is the FormKey before any read has answered', () => {
    expect(recordTitle(FORM_KEY, undefined)).toBe(FORM_KEY);
  });

  it('is the plugin\'s file name for a plugin header', () => {
    expect(recordTitle('000000:MyPatch.esp', [{ plugin: 'A.esp', origin: 'ModA', editorId: null, isWinner: true }])).toBe('MyPatch.esp');
  });
});
