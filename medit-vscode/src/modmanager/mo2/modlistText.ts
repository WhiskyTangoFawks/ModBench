// Pure, byte-faithful text transforms over an MO2 profile's modlist.txt.
//
// modlist.txt lines (top = highest priority):
//   # comment              (preserved verbatim, not surfaced)
//   +Mod Name              (enabled mod)
//   -Mod Name              (disabled mod)
//   +Name_separator        (separator, enabled/disabled via prefix)
//   *DLC: …                (unmanaged/DLC/CC, preserved verbatim, not surfaced)
//
// All mutations splice the raw string in place, so CRLF/LF, trailing newline,
// BOM, and every unmodelled line survive untouched.

import type { ModlistEntry } from '../model';
import { lineRanges } from './lineScan';

const SEPARATOR_SUFFIX = '_separator';

/** Parse modlist.txt into the ordered model view (top = highest priority).
 *  Only +/- mod and separator lines are surfaced; comment/*-prefixed/blank
 *  lines carry no model meaning and are ignored (but preserved on write). */
export function parseModlist(text: string): ModlistEntry[] {
  const entries: ModlistEntry[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const prefix = raw[0];
    if (prefix !== '+' && prefix !== '-') continue; // comment, *, blank
    const enabled = prefix === '+';
    const body = raw.slice(1);
    if (body.endsWith(SEPARATOR_SUFFIX)) {
      entries.push({ kind: 'separator', name: body.slice(0, -SEPARATOR_SUFFIX.length), enabled });
    } else {
      entries.push({ kind: 'mod', name: body, enabled });
    }
  }
  return entries;
}

/** Index of the leading +/- prefix char for the mod line named `modName`, or -1. */
function findModPrefixIndex(text: string, modName: string): number {
  const enabled = '+' + modName;
  const disabled = '-' + modName;
  for (const { start, contentEnd } of lineRanges(text)) {
    const line = text.slice(start, contentEnd);
    if (line === enabled || line === disabled) return start;
  }
  return -1;
}

/** Set a mod's enabled state by flipping its +/- prefix. Throws if the mod is absent. */
export function setEnabledInText(text: string, modName: string, enabled: boolean): string {
  const idx = findModPrefixIndex(text, modName);
  if (idx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
  const desired = enabled ? '+' : '-';
  if (text[idx] === desired) return text;
  return text.slice(0, idx) + desired + text.slice(idx + 1);
}

/** Lines each INCLUDING their trailing EOL (last may lack one); join('') is exact. */
const splitLinesKeepEol = (text: string): string[] =>
  [...lineRanges(text)].map((r) => text.slice(r.start, r.end));

const lineContent = (line: string): string => line.replace(/\r\n$|\r$|\n$/, '');
const isEntryLine = (line: string): boolean => {
  const c = lineContent(line)[0];
  return c === '+' || c === '-';
};

/** Move a mod's line so it occupies entry-index `toIndex` among the +/- entry
 *  lines (top = highest priority), counting the entries *with the moved mod
 *  removed*. Out-of-range clamps to the last entry slot. Non-entry lines
 *  (comment, *) keep their relative position; bytes are preserved. */
export function moveModInText(text: string, modName: string, toIndex: number): string {
  const lines = splitLinesKeepEol(text);
  const srcLine = lines.findIndex(
    (l) => lineContent(l) === '+' + modName || lineContent(l) === '-' + modName,
  );
  if (srcLine === -1) throw new Error(`Mod not found in modlist: ${modName}`);

  const [moved] = lines.splice(srcLine, 1);
  const entryLineIdx = [...lines.keys()].filter((i) => isEntryLine(lines[i]));

  const clamped = Math.max(0, Math.min(toIndex, entryLineIdx.length));
  const lastEntry = entryLineIdx.at(-1);
  let insertAt: number;
  if (clamped < entryLineIdx.length) {
    insertAt = entryLineIdx[clamped]; // before the entry currently at that slot
  } else if (lastEntry === undefined) {
    insertAt = lines.length; // no entries at all
  } else {
    insertAt = lastEntry + 1; // after the last entry, before any trailing * block
  }
  lines.splice(insertAt, 0, moved);
  return lines.join('');
}
