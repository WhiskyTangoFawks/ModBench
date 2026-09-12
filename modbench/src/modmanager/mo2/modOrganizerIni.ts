// Writes touch one key so the rest of the ~20 KB ini survives byte-for-byte.
// MO2 (Qt QSettings) wraps special-character values as `@ByteArray(<value>)`;
// a profile name needs no wrapping, but MO2 writes one, so we match it.

import { lineRanges } from './lineScan';

const KEY = 'selected_profile';
const GAME_KEY = 'gameName';
const GAME_PATH_KEY = 'gamePath';

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
  const captured = /^@ByteArray\((.*)\)$/.exec(raw.trim())?.[1];
  return captured !== undefined ? captured : raw.trim();
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

export function setSelectedProfileInText(text: string, profile: string): string {
  const span = valueSpan(text, KEY);
  if (!span) throw new Error('ModOrganizer.ini: missing selected_profile');
  const next = `@ByteArray(${profile})`;
  return text.slice(0, span.start) + next + text.slice(span.end);
}
