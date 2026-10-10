// MO2 stores its settings in Qt QSettings::IniFormat files: `[section]` headers and `key=value` lines.

import { editLines, splitLines } from '../../loadOrderFileCodec/lineScan';

/** Keys above the first header belong to it too, as QSettings reads them. */
export const GENERAL_SECTION = 'General';

const sectionNameOf = (line: string): string | undefined => {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : undefined;
};

function keyValueOf(line: string): { key: string; value: string } | undefined {
  const eq = line.indexOf('=');
  return eq === -1 ? undefined : { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
}

interface SectionSpan {
  /** The header's line, or -1 for the keys above the first header. */
  header: number;
  /** One past the section's last line. */
  end: number;
}

function findSection(lines: readonly string[], name: string): SectionSpan | undefined {
  const spanFrom = (header: number): SectionSpan => {
    const next = lines.findIndex((line, i) => i > header && sectionNameOf(line) !== undefined);
    return { header, end: next === -1 ? lines.length : next };
  };
  const header = lines.findIndex((line) => sectionNameOf(line) === name);
  if (header !== -1) return spanFrom(header);
  const above = spanFrom(-1);
  const hasLeadingKeys = lines.slice(0, above.end).some((line) => keyValueOf(line) !== undefined);
  return name === GENERAL_SECTION && hasLeadingKeys ? above : undefined;
}

// A repeated key keeps its first line, wherever it is read or edited.
function findKeyLine(lines: readonly string[], section: SectionSpan, key: string): number {
  const body = lines.slice(section.header + 1, section.end);
  const offset = body.findIndex((line) => keyValueOf(line)?.key === key);
  return offset === -1 ? -1 : section.header + 1 + offset;
}

/** Every key of the section, raw and trimmed. */
export function readIniSection(text: string, section: string): Map<string, string> {
  const lines = splitLines(text);
  const span = findSection(lines, section);
  const entries = span ? lines.slice(span.header + 1, span.end).flatMap((line) => keyValueOf(line) ?? []) : [];
  const firsts = entries.filter(({ key }, i) => entries.findIndex((entry) => entry.key === key) === i);
  return new Map(firsts.map(({ key, value }) => [key, value]));
}

export const readIniValue = (text: string, section: string, key: string): string | undefined =>
  readIniSection(text, section).get(key);

// Qt's INI writer escapes backslashes and quotes, inside `@ByteArray(...)` too, and
// quote-wraps a value holding `,` `;` `=` or starting or ending with a space.
const UNESCAPES: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };
const ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** The string a raw value holds. */
export function decodeIniValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const body = quoted ? trimmed.slice(1, -1) : trimmed;
  const unescaped = body.replace(/\\(.)/gs, (whole: string, ch: string) => UNESCAPES[ch] ?? whole);
  return /^@ByteArray\((.*)\)$/s.exec(unescaped)?.[1] ?? unescaped;
}

/** The raw value Qt writes for `value`; `decodeIniValue` reads it back. */
export function encodeIniValue(value: string): string {
  const escaped = value.replace(/[\\"\n\r\t]/g, (ch) => ESCAPES[ch] ?? ch);
  return /[,;=]|^ | $/.test(value) ? `"${escaped}"` : escaped;
}

/** Sets, adds (right after its header) or, for an undefined value, deletes one key. An
 *  absent section is added ahead of everything. Every other line stays as found. */
export function setIniValue(text: string, section: string, key: string, value: string | undefined): string {
  return editLines(text, (lines) => {
    const line = value === undefined ? undefined : `${key}=${encodeIniValue(value)}`;
    const span = findSection(lines, section);
    if (!span) return line === undefined ? lines : [`[${section}]`, line, ...lines];
    const at = findKeyLine(lines, span, key);
    const next = [...lines];
    if (at !== -1) next.splice(at, 1, ...(line === undefined ? [] : [line]));
    else if (line !== undefined) next.splice(span.header + 1, 0, line);
    return next;
  });
}

/** Replaces a section's whole body, appending an absent section at the end and removing the
 *  section when `body` is empty. */
export function replaceIniSection(text: string, section: string, body: readonly string[]): string {
  return editLines(text, (lines) => {
    const span = findSection(lines, section);
    const replacement = body.length === 0 ? [] : [`[${section}]`, ...body];
    if (!span) return [...lines, ...replacement];
    return [...lines.slice(0, span.header), ...replacement, ...lines.slice(span.end)];
  });
}
