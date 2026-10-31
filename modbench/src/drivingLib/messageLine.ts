/** One view's message line, said by several writers: each part present, in order. */
export function messageLine(...parts: (string | undefined)[]): string | undefined {
  const said = parts.filter((part) => part !== undefined);
  return said.length > 0 ? said.join(' ') : undefined;
}

/** A message line as the agent's list of lines: none when the view says nothing. */
export function linesOf(line: string | undefined): string[] {
  return line === undefined ? [] : [line];
}
