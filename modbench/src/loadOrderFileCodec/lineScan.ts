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

const BOM = '\uFEFF';

export const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

/** Applies `edit` to the lines. The file keeps its BOM and whether its last line has a
 *  terminator, and is written whole with the one line ending `detectEol` names. */
export function editLines(text: string, edit: (lines: string[]) => readonly string[]): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  const lines = body === '' ? [] : body.split(/\r\n|\r|\n/);
  const terminated = lines.at(-1) === '' || body === '';
  if (lines.at(-1) === '') lines.pop();
  const edited = edit(lines);
  const eol = detectEol(text);
  return bom + edited.join(eol) + (terminated && edited.length > 0 ? eol : '');
}

/** The positions of the lines `isEntry` accepts. */
export const entryLineIndices = (lines: readonly string[], isEntry: (line: string) => boolean): number[] =>
  [...lines.entries()].filter(([, line]) => isEntry(line)).map(([i]) => i);

/** Whole-file presence, never a one-line sniff, which could name a bare `\r` the
 *  terminator when it is a partial write. Accepted cost: one stray CRLF line
 *  makes a mostly-LF file insert CRLF, with no path back. */
export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
