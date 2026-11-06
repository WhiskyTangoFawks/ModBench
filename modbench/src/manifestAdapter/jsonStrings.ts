interface NameInText {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

type Segment = string | number;

export interface StringAt extends NameInText {
  readonly path: readonly Segment[];
}

/** Closes the path of a string that is a value, where a member's name closes its own. */
export const VALUE = -1;

const WHITESPACE = /\s/;
const SCALAR_END = /[\s,\]}]/;

/** Each string of `text`, a JSON text its read accepted, a member's name or a value, with its path and its span. */
export function stringsOf(text: string): StringAt[] {
  const found: StringAt[] = [];
  let at = 0;
  const skipWhitespace = (): void => { while (WHITESPACE.test(text.charAt(at))) at += 1; };
  const string = (): NameInText => {
    const start = at;
    at += 1;
    while (text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1;
    at += 1;
    const name: unknown = JSON.parse(text.slice(start, at));
    return { name: String(name), start: start + 1, end: at - 1 };
  };
  const items = (close: string, item: (index: number) => void): void => {
    at += 1;
    skipWhitespace();
    for (let index = 0; text.charAt(at) !== close; index += 1) {
      item(index);
      skipWhitespace();
      if (text.charAt(at) === ',') at += 1;
      skipWhitespace();
    }
    at += 1;
  };
  const member = (path: readonly Segment[]): void => {
    const key = string();
    found.push({ ...key, path: [...path, key.name] });
    skipWhitespace();
    at += 1;
    value([...path, key.name]);
  };
  const value = (path: readonly Segment[]): void => {
    skipWhitespace();
    const opening = text.charAt(at);
    if (opening === '"') found.push({ ...string(), path: [...path, VALUE] });
    else if (opening === '{') items('}', () => { member(path); });
    else if (opening === '[') items(']', (index) => { value([...path, index]); });
    else while (at < text.length && !SCALAR_END.test(text.charAt(at))) at += 1;
  };
  value([]);
  return found;
}
