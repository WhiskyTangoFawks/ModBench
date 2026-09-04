// Centralises the error-prone parts of MO2's byte-faithful text transforms: the
// CRLF lookahead, the leading-BOM convention, and the splice arithmetic that the
// modlist and plugins transforms would otherwise each re-implement.

export interface LineRange {
  start: number;
  /** Index just past the line content, before any EOL. */
  contentEnd: number;
  /** Index just past the line including its EOL (== next line's start). */
  end: number;
}

/** Yield each line's range. `text.slice(r.start, r.end)` for every range,
 *  concatenated, reproduces `text` exactly (EOLs preserved). A trailing EOL
 *  does not produce an extra empty line. */
export function* lineRanges(text: string): Generator<LineRange> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' || text[i] === '\r') {
      const end = text[i] === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
      yield { start, contentEnd: i, end };
      i = end - 1;
      start = end;
    }
  }
  if (start < text.length) yield { start, contentEnd: text.length, end: text.length };
}

/** Safe only on a `lineRanges` slice: such a line holds no `\r`/`\n` but its own
 *  trailing terminator, so anchoring the alternation would be redundant. */
export const lineContent = (line: string): string => line.replace(/\r\n$|\r$|\n$/, '');

/** Lines each INCLUDING their trailing EOL (last may lack one); join('') is exact. */
export const splitLinesKeepEol = (text: string): string[] =>
  [...lineRanges(text)].map((r) => text.slice(r.start, r.end));

export const BOM = '﻿';

export const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

/** The BOM is a whole-file property at position 0, never a line's, so it is
 *  stripped and re-prepended around every edit — it stays pinned even when the
 *  line that carried it moves or is removed. */
export function withBomPreserved(text: string, edit: (bomless: string) => string): string {
  if (!text.startsWith(BOM)) return edit(text);
  return BOM + edit(stripBom(text));
}

/** `lines` must already have the moved line(s) spliced out, since `toIndex`
 *  counts only the `isEntry` lines present. Out-of-range clamps to the last
 *  entry slot, or to the end of `lines` when there are no entries. */
export function insertIndexAmongEntries(
  lines: readonly string[],
  isEntry: (line: string) => boolean,
  toIndex: number,
): number {
  const entryLineIdx = [...lines.keys()].filter((i) => isEntry(lines[i]));
  const clamped = Math.max(0, Math.min(toIndex, entryLineIdx.length));
  if (clamped < entryLineIdx.length) return entryLineIdx[clamped];
  return entryLineIdx.length === 0 ? lines.length : entryLineIdx.at(-1)! + 1;
}

/** Whole-file presence, never a one-line sniff, which could name a bare `\r` the
 *  terminator when it is a partial write. Accepted cost: one stray CRLF line
 *  makes a mostly-LF file insert CRLF, with no path back. */
export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
