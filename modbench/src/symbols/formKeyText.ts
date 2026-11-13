import { parseTree, type Node } from 'jsonc-parser';
import { canonicalFormKey, FORM_KEY, isStringOf, isStringValue, ownFormKey, recordOf, spanOf, stringNodeAt, type Segment, type TextSpan } from '../drivingLib/sourceText';
import { sameName } from '../symbolNames/symbolNames';

/** The FormKey string under `offset`, and its span. */
export function formKeyAt(text: string, offset: number): (TextSpan & { formKey: string }) | undefined {
  const node = stringNodeAt(parseTree(text), offset);
  const value: unknown = node?.value;
  return node && typeof value === 'string' && FORM_KEY.test(value) ? { formKey: canonicalFormKey(value), ...spanOf(node) } : undefined;
}

function formKeyValueNode(text: string, formKey: string): Node | undefined {
  const root = parseTree(text);
  const record = root && recordOf(root, formKey);
  return record && ownFormKey(record);
}

/** The span of the `FormKey` member of the record `formKey` names. */
export function formKeyMember(text: string, formKey: string): TextSpan | undefined {
  const member = formKeyValueNode(text, formKey)?.parent;
  return member ? spanOf(member) : undefined;
}

/** The span of the `FormKey` value of the record `formKey` names. */
export function formKeyValue(text: string, formKey: string): TextSpan | undefined {
  const value = formKeyValueNode(text, formKey);
  return value ? spanOf(value) : undefined;
}

const valuesOf = (node: Node): Node[] => (node.type === 'property' ? node.children?.slice(1) : node.children) ?? [];

// A nested object with a FormKey of its own is a child record, whose references are its own
// (symbols.md, The symbols, Record).
function firstReference(record: Node, formKey: string): Node | undefined {
  const own = ownFormKey(record)?.parent;
  for (const child of valuesOf(record)) {
    if (child === own || ownFormKey(child) !== undefined) continue;
    const found = isStringOf(formKey)(child) ? child : firstReference(child, formKey);
    if (found) return found;
  }
  return undefined;
}

/** Where the record `referrer` references `formKey`: its first reference, else its own FormKey; the
 *  start of the text when the record is absent. */
export function referenceSpan(text: string, referrer: string, formKey: string): TextSpan {
  const root = parseTree(text);
  const record = root && recordOf(root, referrer);
  const found = record && (firstReference(record, formKey) ?? ownFormKey(record));
  return found ? spanOf(found) : { start: 0, end: 0 };
}

// A FormKey's six-digit object ID and its delimiter come before its plugin's name.
const PLUGIN_NAME_OFFSET = 7;

/** The plugin's name in a FormKey. */
export const pluginNameIn = (formKey: string): string => formKey.slice(PLUGIN_NAME_OFFSET);

const pluginPartOf = (node: Node): TextSpan & { name: string } =>
  ({ name: String(node.value).slice(PLUGIN_NAME_OFFSET), start: node.offset + 1 + PLUGIN_NAME_OFFSET, end: node.offset + node.length - 1 });

const isFormKeyString = (node: Node): boolean => isStringValue(node) && typeof node.value === 'string' && FORM_KEY.test(node.value);

/** The plugin's name in the FormKey string under `offset`, and its span. */
export function formKeyPluginAt(text: string, offset: number): (TextSpan & { name: string }) | undefined {
  const node = stringNodeAt(parseTree(text), offset);
  const part = node && isFormKeyString(node) ? pluginPartOf(node) : undefined;
  return part && offset >= part.start && offset <= part.end ? part : undefined;
}

function formKeysOf(record: Node): Node[] {
  return valuesOf(record).flatMap((child) => {
    if (child.type !== 'object' && child.type !== 'array' && child.type !== 'property') return isFormKeyString(child) ? [child] : [];
    return child.type === 'object' && ownFormKey(child) !== undefined ? [] : formKeysOf(child);
  });
}

/** Where the record `formKey` names the plugin `name`: the name in each of its FormKeys that names it, else its own
 *  FormKey; the start of the text when the record is absent. */
export function pluginNameSpans(text: string, formKey: string, name: string): TextSpan[] {
  const root = parseTree(text);
  const record = root && recordOf(root, formKey);
  if (!record) return [{ start: 0, end: 0 }];
  const naming = formKeysOf(record).map(pluginPartOf).filter((part) => sameName(part.name, name));
  const own = ownFormKey(record);
  return naming.length > 0 ? naming.map(({ start, end }) => ({ start, end })) : own ? [spanOf(own)] : [{ start: 0, end: 0 }];
}

export const fieldPathOf = (path: readonly Segment[]): string =>
  path.reduce<string>((text, segment) => typeof segment === 'number' ? `${text}[${segment}]` : text === '' ? segment : `${text}.${segment}`, '');

