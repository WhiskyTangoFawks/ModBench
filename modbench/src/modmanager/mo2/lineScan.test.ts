import { describe, it, expect } from 'vitest';
import { lineRanges } from './lineScan';

// lineRanges' own contract (see its docstring): every line's range, sliced and
// concatenated, reproduces the input exactly, and a trailing EOL never produces
// an extra empty line. These inputs are its edge cases: a bare-LF blank line
// between two entries (distinct from the CRLF lookahead), a bare CR *not*
// followed by LF (distinct from a true CRLF pair), and a final line with no
// trailing EOL at all.

describe('lineRanges', () => {
  it('treats a bare LF blank line as its own line, not merged with its neighbor', () => {
    // A blank line that is just "\n" (no \r) must not be swept into the
    // preceding or following line's range — each of the three lines here has
    // its own {start, contentEnd, end}.
    const text = '+A\n\n+B\n';
    expect([...lineRanges(text)]).toEqual([
      { start: 0, contentEnd: 2, end: 3 }, // "+A\n"
      { start: 3, contentEnd: 3, end: 4 }, // "\n" (blank)
      { start: 4, contentEnd: 6, end: 7 }, // "+B\n"
    ]);
  });

  it('treats a bare CR not followed by LF as a 1-char line ending, not a CRLF pair', () => {
    // Only "\r" immediately followed by "\n" is a 2-char CRLF terminator; a
    // lone "\r" (classic Mac-style ending) must consume just itself, or the
    // character right after it is silently swallowed into the "terminator".
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
