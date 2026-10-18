import { describe, it, expect } from 'vitest';
import { editLines } from '../lineScan';

describe('editLines', () => {
  const unchanged = (lines: string[]): string[] => lines;

  it.each([
    ['LF', 'a\nb\n'],
    ['CRLF', 'a\r\nb\r\n'],
    ['a BOM', '﻿a\r\nb\r\n'],
    ['no final terminator', 'a\r\nb'],
    ['blank lines', 'a\r\n\r\nb\r\n\r\n'],
    ['an empty file', ''],
  ])('writes a file back as it read it: %s', (_name, text) => {
    expect(editLines(text, unchanged)).toBe(text);
  });

  it.each([
    ['LF and CRLF lines keeps each line\'s own, and a new line takes CRLF', 'a\nb\r\n', 'a\nb\r\nc\r\n'],
    ['bare CR lines keeps them, and a new line takes LF', 'a\rb\r', 'a\rb\rc\n'],
  ])('a file of %s', (_name, text, expected) => {
    expect(editLines(text, (lines) => [...lines, 'c'])).toBe(expected);
  });

  it('moves a line with its own terminator', () => {
    expect(editLines('a\nb\r\n', (lines) => [...lines].reverse())).toBe('b\r\na\n');
  });

  it('keeps the BOM at the start when the line that carried it is removed', () => {
    expect(editLines('﻿a\r\nb\r\n', (lines) => lines.slice(1))).toBe('﻿b\r\n');
  });

  it('keeps a missing final terminator missing when a line is added at the end', () => {
    expect(editLines('a\nb', (lines) => [...lines, 'c'])).toBe('a\nb\nc');
  });

  it('terminates the first line of an empty file', () => {
    expect(editLines('', () => ['a'])).toBe('a\n');
  });
});
