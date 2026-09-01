import { describe, it, expect } from 'vitest';
import { lineRanges, detectEol } from './lineScan';

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

// #635: modlistText.ts and pluginsText.ts each had their own detectEol, and the two
// disagreed — modlistText.ts scanned the whole file for any CRLF; pluginsText.ts sniffed
// only the first terminated line. Ruled: whole-file CRLF-presence wins (rule B) for both
// callers. Reasoning (recorded here, not just in the PR): a bare `\r` is very likely a
// partial write or a bad tool, and rule A (first-line sniff) was the only rule that could
// ever surface one as "the" file terminator; rule B structurally cannot. Rule A also samples
// exactly the least representative line — line 1 is where BOM damage and partial writes
// concentrate. Rule B is monotone: once every write append is `\r\n` or `\n` consistently,
// a mixed file converges instead of staying permanently mixed. Byte-faithfulness does not
// decide this either way — that invariant governs bytes already on disk, and a newly
// inserted line has none.
//
// Known drawback, accepted rather than hidden: rule B is sticky toward CRLF — a file that is
// mostly LF plus one stray CRLF line (however it got there) makes every subsequent insertion
// CRLF, with no path back to all-LF. Accepted because the file was already mixed, and every
// real consumer of modlist.txt/plugins.txt trims trailing `\r`.
describe('detectEol — the single ruled implementation (#635)', () => {
  it('a file with both LF- and CRLF-terminated lines detects CRLF (the historical divergence case)', () => {
    // modlistText.ts's old whole-file scan said '\r\n' here; pluginsText.ts's old
    // first-line sniff said '\n' (the first line is LF-terminated). Ruled: '\r\n'.
    expect(detectEol('+ModA\n+ModB\r\n')).toBe('\r\n');
  });

  it('never returns a bare CR, even when the first line is CR-terminated', () => {
    // The old first-line-sniff rule (pluginsText.ts) would have returned '\r' here — the one
    // input where it could surface a bare-CR terminator as "the" file's EOL. Rule B can't:
    // there is no '\r\n' substring in this text, so it falls through to '\n'.
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
