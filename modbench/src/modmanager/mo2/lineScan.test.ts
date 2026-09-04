import { describe, it, expect } from 'vitest';
import { lineRanges, detectEol } from './lineScan';

describe('lineRanges', () => {
  it('treats a bare LF blank line as its own line, not merged with its neighbor', () => {
    const text = '+A\n\n+B\n';
    expect([...lineRanges(text)]).toEqual([
      { start: 0, contentEnd: 2, end: 3 }, // "+A\n"
      { start: 3, contentEnd: 3, end: 4 }, // "\n" (blank)
      { start: 4, contentEnd: 6, end: 7 }, // "+B\n"
    ]);
  });

  it('treats a bare CR not followed by LF as a 1-char line ending, not a CRLF pair', () => {
    // A lone "\r" is a classic Mac-style ending and must consume just itself, or
    // the character after it is swallowed into the terminator.
    const text = 'A\rB';
    expect([...lineRanges(text)]).toEqual([
      { start: 0, contentEnd: 1, end: 2 }, // "A\r"
      { start: 2, contentEnd: 3, end: 3 }, // "B" (no EOL)
    ]);
  });

  it('yields the final line even when it has no trailing EOL, without a spurious extra range', () => {
    const text = '+A\r\n+B';
    expect([...lineRanges(text)]).toEqual([
      { start: 0, contentEnd: 2, end: 4 }, // "+A\r\n"
      { start: 4, contentEnd: 6, end: 6 }, // "+B" (no EOL)
    ]);
  });
});

// Whole-file CRLF presence is the ruled implementation: sniffing one line could
// surface a bare `\r` as the terminator, and a bare `\r` is a partial write.
describe('detectEol — the single ruled implementation (#635)', () => {
  it('a file with both LF- and CRLF-terminated lines detects CRLF (the historical divergence case)', () => {
    expect(detectEol('+ModA\n+ModB\r\n')).toBe('\r\n');
  });

  it('never returns a bare CR, even when the first line is CR-terminated', () => {
    // The one input a first-line sniff would call a bare-CR file; whole-file
    // presence finds no '\r\n' substring and falls through to '\n'.
    expect(detectEol('+ModA\r+ModB\n')).toBe('\n');
    expect(detectEol('+ModA\r+ModB\n')).not.toBe('\r');
  });

  it('an all-LF file detects LF', () => {
    expect(detectEol('+ModA\n+ModB\n')).toBe('\n');
  });

  it('falls back to LF for an empty text or one with no terminator anywhere — a deliberate hold, not an inherited accident: both prior implementations already agreed on this fallback, and this consolidation doesn\'t re-decide it', () => {
    expect(detectEol('')).toBe('\n');
    expect(detectEol('no terminator at all')).toBe('\n');
  });
});
