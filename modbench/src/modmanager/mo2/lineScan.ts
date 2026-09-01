// Shared, EOL-aware line scanning for the byte-faithful MO2 text transforms.
// Centralises the one error-prone bit — handling \r\n vs \r vs \n — so the
// surgical edit/parse helpers don't each re-implement the CRLF lookahead.

export interface LineRange {
  /** Index of the first character of the line. */
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

/** Strip a single trailing EOL (CRLF, CR, or LF) from a line. Only ever reachable
 *  with `lineRanges` output (or an equivalent one-line, ≤1-trailing-terminator
 *  slice) — that guarantee is what makes the three-way alternation safe: such a
 *  line never contains a `\r`/`\n` other than its own trailing terminator, so
 *  anchoring each alternative is redundant, not load-bearing. */
export const lineContent = (line: string): string => line.replace(/\r\n$|\r$|\n$/, '');

/** Lines each INCLUDING their trailing EOL (last may lack one); join('') is exact. */
export const splitLinesKeepEol = (text: string): string[] =>
  [...lineRanges(text)].map((r) => text.slice(r.start, r.end));

export const BOM = '﻿';

export const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

/** The BOM is a whole-file property (always at absolute position 0), never a
 *  line's. Every surgical edit strips it up front, edits the bomless text
 *  with the (BOM-unaware) helpers below, then re-prepends it — so the BOM
 *  stays pinned to position 0 even when the line that carried it is edited,
 *  moved, or removed. Shared by modlistText.ts and pluginsText.ts, whose
 *  surgical edits both need exactly this. */
export function withBomPreserved(text: string, edit: (bomless: string) => string): string {
  if (!text.startsWith(BOM)) return edit(text);
  return BOM + edit(stripBom(text));
}

/** Splice index, among `lines`, for inserting a moved entry (or entry block) so
 *  it occupies entry-index `toIndex` — counting only the lines `isEntry`
 *  selects, among `lines` as given (i.e. after any earlier splice already
 *  removed the moved line(s)). Out-of-range `toIndex` clamps to the last entry
 *  slot; when `lines` has no entries at all, the index lands at the very end.
 *  Shared by modlistText.ts's `moveModInText`/`moveSeparatorBlockInText` and
 *  pluginsText.ts's `movePluginsInText` — all three insert a moved block back
 *  into the same kind of by-entry-index slot, over otherwise-unrelated line
 *  shapes (mod, separator, plugin). */
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

/** The file's EOL: CRLF if the text contains a CRLF terminator anywhere, else LF. Whole-file
 *  presence, not a sniff of any one line — modlistText.ts and pluginsText.ts each had their own
 *  detectEol before this consolidation, and disagreed: pluginsText.ts sniffed only the first
 *  terminated line, which is both the least representative line (BOM damage and partial writes
 *  concentrate there) and the only rule of the two that could surface a bare `\r` as "the" file's
 *  terminator — a bare `\r` is almost always a partial write or a bad tool, the worst possible
 *  thing to treat as intent. This rule structurally can't produce one. It's also monotone: every
 *  write this module makes is `\r\n` or `\n` consistently, so a mixed file converges toward
 *  consistency instead of staying permanently mixed. Byte-faithfulness does not decide between the
 *  two rules — that invariant governs bytes already on disk, and a newly inserted line has none.
 *
 *  Known drawback, accepted rather than hidden: sticky toward CRLF — a file that's mostly LF plus
 *  one stray CRLF line makes every subsequent insertion CRLF, with no path back to all-LF.
 *  Accepted: the file was already mixed, and every real consumer of these formats trims `\r`.
 *
 *  The empty-text / no-terminator-anywhere fallback (`\n`) is a separate, deliberately undisturbed
 *  decision: both prior implementations already agreed on it, and this consolidation doesn't
 *  re-decide it — a Windows-native fallback of `\r\n` is a plausible alternative, but that's its
 *  own ticket with its own reasoning, not a side effect of this one. */
export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
