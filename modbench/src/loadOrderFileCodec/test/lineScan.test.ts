import { describe, it, expect } from 'vitest';
import { lineRanges, detectEol } from '../lineScan';

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
