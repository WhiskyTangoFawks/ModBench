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
