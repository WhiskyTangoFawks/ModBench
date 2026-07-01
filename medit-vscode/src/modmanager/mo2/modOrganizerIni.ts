// Read/write ModOrganizer.ini's active-profile pointer. Writes are surgical
// (single key) so the rest of the ~20 KB ini survives byte-for-byte.
//
// MO2 (Qt QSettings) wraps values containing special characters as
// `@ByteArray(<value>)`. selected_profile is a plain profile name; we always
// write it wrapped, matching MO2's own output.

import { lineRanges } from './lineScan';

const KEY = 'selected_profile';
const GAME_KEY = 'gameName';

/** Span of the value (right of `=`) on the line for `key`, or null. */
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

function unwrap(raw: string): string {
  const m = /^@ByteArray\((.*)\)$/.exec(raw.trim());
  return m ? m[1] : raw.trim();
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

export function setSelectedProfileInText(text: string, profile: string): string {
  const span = valueSpan(text, KEY);
  if (!span) throw new Error('ModOrganizer.ini: missing selected_profile');
  const next = `@ByteArray(${profile})`;
  if (text.slice(span.start, span.end) === next) return text;
  return text.slice(0, span.start) + next + text.slice(span.end);
}
