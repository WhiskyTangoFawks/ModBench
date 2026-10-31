export type Json = Record<string, unknown>;

/** Why a file cannot be read, as a clause. */
export class Unreadable extends Error {}

export const unreadable = (file: string, where: string, why?: string): Unreadable =>
  new Unreadable(`its ${file} cannot be read${where ? ` at ${where}` : ''}${why ? `: ${why}` : ''}`);

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export const objectOf = (file: string, value: unknown, where: string): Json => {
  if (!isObject(value)) throw unreadable(file, where);
  return value;
};

export const textOf = (file: string, value: unknown, where: string): string => {
  if (typeof value !== 'string') throw unreadable(file, where);
  return value;
};

export const arrayOf = (file: string, value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value)) throw unreadable(file, where);
  return value;
};

export const stringsOf = (file: string, value: unknown, where: string): string[] => arrayOf(file, value, where).map((item) => textOf(file, item, where));

export const required = (file: string, line: Json, key: string, where: string): unknown => {
  if (!Object.hasOwn(line, key)) throw unreadable(file, where);
  return line[key];
};

export const PATH = /^(?!\/)(?!.*\/$)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[^\\:]+$/;

/** Whether `path` is a path relative to a folder, as the formats' schemas state it. */
export const isPathInTheFolder = (path: string): boolean => PATH.test(path);

/** Refuses a member of `members` that `keys` does not name; `part` names the object in the file. */
export const known = (file: string, members: Json, part: string | undefined, keys: readonly string[]): void => {
  const unknownKey = Object.keys(members).find((key) => !keys.includes(key));
  if (unknownKey !== undefined) {
    throw new Unreadable(`its ${file}${part === undefined ? '' : `'s ${part}`} holds '${unknownKey}', which Modbench does not read`);
  }
};

const leavesTheTextIncomplete = (prefix: string): boolean => {
  try {
    JSON.parse(prefix);
    return false;
  } catch (problem) {
    const message = problem instanceof Error ? problem.message : '';
    const position = /at position (\d+)/.exec(message)?.[1];
    return /end of JSON input/.test(message) || (position !== undefined && Number(position) >= prefix.length);
  }
};

const firstUnparsableLength = (text: string): number => {
  let [low, high] = [0, text.length];
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (leavesTheTextIncomplete(text.slice(0, middle))) low = middle + 1;
    else high = middle;
  }
  return low;
};

const lineOf = (problem: SyntaxError, text: string): string => {
  const reported = /\(line (\d+) column/.exec(problem.message)?.[1];
  if (reported !== undefined) return ` at line ${reported}`;
  const offending = firstUnparsableLength(text) - 1;
  return offending < 0 ? '' : ` at line ${text.slice(0, offending).split('\n').length}`;
};

/** `text` parsed and read by `of`; a text that is no JSON, or that `of` cannot read, is refused, naming where. */
export function parsed<T>(text: string, file: string, of: (value: unknown) => T): { readonly read: T } | { readonly refused: string } {
  try {
    return { read: of(JSON.parse(text)) };
  } catch (problem) {
    if (problem instanceof Unreadable) return { refused: problem.message };
    if (problem instanceof SyntaxError) return { refused: `its ${file} cannot be read${lineOf(problem, text)}` };
    throw problem;
  }
}
