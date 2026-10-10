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
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
