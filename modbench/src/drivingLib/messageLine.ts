/** One view's message line, said by several writers: each part present, in order, each a sentence. */
export function messageLine(...parts: (string | undefined)[]): string | undefined {
  const said = parts.filter((part) => part !== undefined);
  if (said.length === 0) return undefined;
  return said.map((part, i) => (i < said.length - 1 && !part.endsWith('.') ? `${part}.` : part)).join(' ');
}
