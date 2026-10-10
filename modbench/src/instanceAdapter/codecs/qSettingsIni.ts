// MO2 stores its settings in Qt QSettings::IniFormat files: `[section]` headers and `key=value` lines.

import { editLines } from '../../loadOrderFileCodec/lineScan';

const sectionNameOf = (line: string): string | undefined => {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : undefined;
};

function keyValueOf(line: string): { key: string; value: string } | undefined {
  const eq = line.indexOf('=');
  return eq === -1 ? undefined : { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
}

interface SectionSpan {
  header: number;
  /** One past the section's last line. */
  end: number;
}

function findSection(lines: readonly string[], name: string): SectionSpan | undefined {
  const header = lines.findIndex((line) => sectionNameOf(line) === name);
  if (header === -1) return undefined;
  const next = lines.findIndex((line, i) => i > header && sectionNameOf(line) !== undefined);
  return { header, end: next === -1 ? lines.length : next };
}

function findKeyLine(lines: readonly string[], section: SectionSpan, key: string): number {
  const body = lines.slice(section.header + 1, section.end);
  const offset = body.findLastIndex((line) => keyValueOf(line)?.key === key);
  return offset === -1 ? -1 : section.header + 1 + offset;
}

/** Every key of the section, raw and trimmed; a repeated key keeps its last value. */
export function readIniSection(text: string, section: string): Map<string, string> {
  const lines = text.split(/\r\n|\r|\n/);
  const span = findSection(lines, section);
  const entries = span ? lines.slice(span.header + 1, span.end).flatMap((line) => keyValueOf(line) ?? []) : [];
  return new Map(entries.map(({ key, value }) => [key, value]));
}

export const readIniValue = (text: string, section: string, key: string): string | undefined =>
  readIniSection(text, section).get(key);

// Qt's INI writer escapes a plain string's own backslashes and quotes, and quote-wraps the
// value only when a character needs it. `@ByteArray(...)` content is raw bytes.
const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };

/** The string a raw value holds. */
export function decodeIniValue(raw: string): string {
  const trimmed = raw.trim();
  const byteArray = /^@ByteArray\((.*)\)$/.exec(trimmed)?.[1];
  if (byteArray !== undefined) return byteArray;
  const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const body = quoted ? trimmed.slice(1, -1) : trimmed;
  return body.replace(/\\(.)/g, (whole: string, ch: string) => ESCAPES[ch] ?? whole);
}

/** Sets, adds (right after its header) or, for an undefined value, deletes one key. An
 *  absent section is added ahead of everything. Every other line stays as found. */
export function setIniValue(text: string, section: string, key: string, value: string | undefined): string {
  return editLines(text, (lines) => {
    const span = findSection(lines, section);
    if (!span) return value === undefined ? lines : [`[${section}]`, `${key}=${value}`, ...lines];
    const at = findKeyLine(lines, span, key);
    const next = [...lines];
    if (at !== -1) next.splice(at, 1, ...(value === undefined ? [] : [`${key}=${value}`]));
    else if (value !== undefined) next.splice(span.header + 1, 0, `${key}=${value}`);
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
