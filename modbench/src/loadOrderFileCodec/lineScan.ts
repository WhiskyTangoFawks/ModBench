const BOM = '\uFEFF';

export const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

export const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** Applies `edit` to the lines. The file keeps its BOM and whether its last line has a
 *  terminator, and each line keeps its own terminator; a new line takes the one `detectEol` names. */
export function editLines(text: string, edit: (lines: string[]) => readonly string[]): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const parts = text.slice(bom.length).split(/(\r\n|\r|\n)/);
  const lines = parts.filter((_, at) => at % 2 === 0);
  const terminated = lines.at(-1) === '';
  if (terminated) lines.pop();
  const endsOf = new Map<string, string[]>();
  lines.forEach((line, at) => {
    const end = parts[2 * at + 1];
    if (end !== undefined) endsOf.set(line, [...endsOf.get(line) ?? [], end]);
  });
  const edited = edit(lines);
  const eol = detectEol(text);
  return bom + edited.map((line, at) =>
    (!terminated && at === edited.length - 1 ? line : line + (endsOf.get(line)?.shift() ?? eol))).join('');
}

/** The positions of the lines `isEntry` accepts. */
export const entryLineIndices = (lines: readonly string[], isEntry: (line: string) => boolean): number[] =>
  [...lines.entries()].filter(([, line]) => isEntry(line)).map(([i]) => i);

// Whole-file presence, never a one-line sniff, which could name a bare `\r` the
// terminator when it is a partial write. Accepted cost: one stray CRLF line
// makes a mostly-LF file insert CRLF, with no path back.
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
