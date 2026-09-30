// Writes touch one key so the rest of the ~20 KB ini survives byte-for-byte.
// MO2 (Qt QSettings) wraps special-character values as `@ByteArray(<value>)`;
// a profile name needs no wrapping, but MO2 writes one, so we match it.

import { lineRanges } from './lineScan';

/** MO2's settings file, at the instance root. */
export const SETTINGS_FILE_NAME = 'ModOrganizer.ini';

const KEY = 'selected_profile';
const GAME_KEY = 'gameName';
const GAME_PATH_KEY = 'gamePath';
const DOWNLOAD_DIRECTORY_KEY = 'download_directory';

function valueSpan(text: string, key: string): { start: number; end: number } | null {
  for (const { start, contentEnd } of lineRanges(text)) {
    const line = text.slice(start, contentEnd);
    const eq = line.indexOf('=');
    if (eq !== -1 && line.slice(0, eq).trim() === key) {
      return { start: start + eq + 1, end: contentEnd };
    }
  }
  return null;
}

function unwrapByteArray(raw: string): string | undefined {
  return /^@ByteArray\((.*)\)$/.exec(raw.trim())?.[1];
}

function unwrap(raw: string): string {
  return unwrapByteArray(raw) ?? raw.trim();
}

// Qt's INI writer escapes a plain (non-@ByteArray) string's own backslashes and quotes, and
// quote-wraps the whole value only when a character needs it. `@ByteArray(...)` content is raw
// bytes and needs none of this.
const INI_ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };
function unescapePlainIniValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const body = quoted ? trimmed.slice(1, -1) : trimmed;
  return body.replace(/\\(.)/g, (whole: string, ch: string) => INI_ESCAPES[ch] ?? whole);
}

export function readSelectedProfile(text: string): string {
  const span = valueSpan(text, KEY);
  if (!span) throw new Error('ModOrganizer.ini: missing selected_profile');
  return unwrap(text.slice(span.start, span.end));
}

export function readGameName(text: string): string {
  const span = valueSpan(text, GAME_KEY);
  if (!span) throw new Error('ModOrganizer.ini: missing gameName');
  return text.slice(span.start, span.end).trim();
}

export function readGamePath(text: string): string {
  const span = valueSpan(text, GAME_PATH_KEY);
  if (!span) throw new Error('ModOrganizer.ini: missing gamePath');
  return unwrap(text.slice(span.start, span.end));
}

/** `[Settings] download_directory`, undefined when unset or empty — MO2's own default then
 *  applies either way: its own UI removes the key rather than write an empty value. */
export function readDownloadDirectory(text: string): string | undefined {
  const span = valueSpan(text, DOWNLOAD_DIRECTORY_KEY);
  if (!span) return undefined;
  const raw = text.slice(span.start, span.end);
  const value = unwrapByteArray(raw) ?? unescapePlainIniValue(raw);
  return value === '' ? undefined : value;
}

export function setSelectedProfileInText(text: string, profile: string): string {
  const span = valueSpan(text, KEY);
  if (!span) throw new Error('ModOrganizer.ini: missing selected_profile');
  const next = `@ByteArray(${profile})`;
  return text.slice(0, span.start) + next + text.slice(span.end);
}
