/** One view's message line, said by several writers: each part present, in order. */
export function messageLine(...parts: (string | undefined)[]): string | undefined {
  const said = parts.filter((part) => part !== undefined);
  return said.length > 0 ? said.join(' ') : undefined;
}
