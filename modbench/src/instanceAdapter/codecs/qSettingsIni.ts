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

/** Every key of the section with its decoded value. */
export function readIniSection(text: string, section: string): Map<string, string> {
  const lines = splitLines(text);
  const span = findSection(lines, section);
  const entries = span ? lines.slice(span.header + 1, span.end).flatMap((line) => keyValueOf(line) ?? []) : [];
  const firsts = entries.filter(({ key }, i) => entries.findIndex((entry) => entry.key === key) === i);
  return new Map(firsts.map(({ key, value }) => [key, decodeIniValue(value)]));
}

export const readIniValue = (text: string, section: string, key: string): string | undefined =>
  readIniSection(text, section).get(key);

// Qt's INI reader and writer (qsettings.cpp: iniUnescapedStringList, iniEscapedString,
// variantToString): an escape yields one UTF-16 unit, `\x` takes any number of hex digits, an
// unknown escape is dropped, and a QByteArray is `@ByteArray(` its bytes as latin-1 `)`.
const NAMED_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '?': '?', "'": "'", '\\': '\\',
};
const CONTROL_ESCAPES: Record<string, string> = { '\x07': 'a', '\b': 'b', '\f': 'f', '\n': 'n', '\r': 'r', '\t': 't', '\v': 'v' };

function unescapeUnits(body: string): string {
  return body.replace(/\\(?:x([0-9a-fA-F]+)|([0-7]+)|([\s\S])?)/g, (_whole, hex?: string, octal?: string, ch?: string) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8));
    return NAMED_ESCAPES[ch ?? ''] ?? '';
  });
}

function decodeIniValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const units = unescapeUnits(quoted ? trimmed.slice(1, -1) : trimmed);
  const bytes = /^@ByteArray\((.*)\)$/s.exec(units)?.[1];
  if (bytes !== undefined) return Buffer.from(bytes.replace(/[^\x00-\xff]/g, '?'), 'latin1').toString('utf8');
  return units.startsWith('@@') ? units.slice(1) : units;
}

const isNumericEscaped = (ch: string, escapeHigh: boolean, followsNumeric: boolean): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return true;
  if (ch in CONTROL_ESCAPES) return false;
  return code <= 0x1f || (escapeHigh && code >= 0x7f) || (followsNumeric && /[0-9a-fA-F]/.test(ch));
};

const escapeUnit = (ch: string, numeric: boolean): string => {
  if (numeric) return ch === '\0' ? '\\0' : `\\x${(ch.codePointAt(0) ?? 0).toString(16)}`;
  if (ch in CONTROL_ESCAPES) return `\\${CONTROL_ESCAPES[ch]}`;
  return ch === '"' || ch === '\\' ? `\\${ch}` : ch;
};

// A hex digit after a numeric escape would read as part of it, so it is escaped too.
function escapeUnits(units: string, escapeHigh: boolean): string {
  let followsNumeric = false;
  let out = '';
  for (const ch of units) {
    followsNumeric = isNumericEscaped(ch, escapeHigh, followsNumeric);
    out += escapeUnit(ch, followsNumeric);
  }
  return out;
}

const quoteIfNeeded = (text: string, escaped: string): string => (/[,;=]|^ | $/.test(text) ? `"${escaped}"` : escaped);

// The raw value Qt writes for `value`; `decodeIniValue` reads it back.
const encodeIniValue = (value: string): string => quoteIfNeeded(value, escapeUnits(value.startsWith('@') ? `@${value}` : value, false));

// The raw value Qt writes for a QByteArray holding `value` as UTF-8.
function encodeByteArray(value: string): string {
  const bytes = `@ByteArray(${Buffer.from(value, 'utf8').toString('latin1')})`;
  return quoteIfNeeded(bytes, escapeUnits(bytes, true));
}

/** Sets, adds (right after its header) or, for an undefined value, deletes one key. An
 *  absent section is added ahead of everything. Every other line stays as found. */
export const setIniValue = (text: string, section: string, key: string, value: string | undefined): string =>
  setRawIniValue(text, section, key, value === undefined ? undefined : encodeIniValue(value));

/** Sets one key to a QByteArray of `value`'s UTF-8 bytes. */
export const setIniByteArray = (text: string, section: string, key: string, value: string): string =>
  setRawIniValue(text, section, key, encodeByteArray(value));

function setRawIniValue(text: string, section: string, key: string, raw: string | undefined): string {
  return editLines(text, (lines) => {
    const line = raw === undefined ? undefined : `${key}=${raw}`;
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
