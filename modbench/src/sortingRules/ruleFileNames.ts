import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { REGEX_NAME } from './lootMetadata';

interface NameInText {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

const QUOTED = new Set(['QUOTE_DOUBLE', 'QUOTE_SINGLE']);

function nameIn(node: unknown): NameInText[] {
  if (!isScalar(node) || typeof node.value !== 'string' || REGEX_NAME.test(node.value) || node.range === undefined || node.range === null) return [];
  const quote = QUOTED.has(String(node.type)) ? 1 : 0;
  return [{ name: node.value, start: node.range[0] + quote, end: node.range[1] - quote }];
}

const fileNamesIn = (list: unknown): NameInText[] =>
  isSeq(list) ? list.items.flatMap((item: unknown) => nameIn(isMap(item) ? item.get('name', true) : item)) : [];

/** Each plugin a LOOT metadata file names, with the span of its name: each entry's own name and each its `after`,
 *  `req` and `inc` name, a regular expression left out; or why the file does not read. */
export function ruleFilePluginNames(text: string): readonly NameInText[] | { readonly refused: string } {
  const document = parseDocument(text);
  const [error] = document.errors;
  if (error !== undefined) return { refused: error.message.split('\n')[0] ?? error.message };
  const plugins = document.get('plugins', true);
  if (!isSeq(plugins)) return [];
  return plugins.items.flatMap((entry: Node | unknown) => isMap(entry)
    ? [...nameIn(entry.get('name', true)), ...['after', 'req', 'inc'].flatMap((key) => fileNamesIn(entry.get(key, true)))]
    : []);
}
