import { describe, it, expect } from 'vitest';
import { lineRanges, detectEol, editLines } from '../lineScan';

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

const contentAndEol = (text: string): [string, string][] =>
  [...lineRanges(text)].map((r) => [text.slice(r.start, r.contentEnd), text.slice(r.contentEnd, r.end)]);

describe('lineRanges', () => {
  it('treats a bare LF blank line as its own line, not merged with its neighbor', () => {
    expect(contentAndEol('+A\n\n+B\n')).toEqual([['+A', '\n'], ['', '\n'], ['+B', '\n']]);
  });

  it('ends a line at a bare CR without swallowing the character after it', () => {
    expect(contentAndEol('A\rB')).toEqual([['A', '\r'], ['B', '']]);
  });

  it('yields the final line even when it has no trailing EOL, without a spurious extra range', () => {
    expect(contentAndEol('+A\r\n+B')).toEqual([['+A', '\r\n'], ['+B', '']]);
  });
});

describe('detectEol', () => {
  it('a file with both LF- and CRLF-terminated lines detects CRLF', () => {
    expect(detectEol('+ModA\n+ModB\r\n')).toBe('\r\n');
  });

  it('never returns a bare CR, even when the first line is CR-terminated', () => {
    expect(detectEol('+ModA\r+ModB\n')).toBe('\n');
  });

  it('an all-LF file detects LF', () => {
    expect(detectEol('+ModA\n+ModB\n')).toBe('\n');
  });

  it('falls back to LF for an empty text or one with no terminator anywhere', () => {
    expect(detectEol('')).toBe('\n');
    expect(detectEol('no terminator at all')).toBe('\n');
  });
});
