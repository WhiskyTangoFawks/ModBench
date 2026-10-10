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
    ['LF and CRLF lines is written with CRLF throughout', 'a\nb\r\n', 'a\r\nb\r\nc\r\n'],
    ['bare CR lines is written with LF throughout', 'a\rb\r', 'a\nb\nc\n'],
  ])('a file of %s', (_name, text, expected) => {
    expect(editLines(text, (lines) => [...lines, 'c'])).toBe(expected);
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
