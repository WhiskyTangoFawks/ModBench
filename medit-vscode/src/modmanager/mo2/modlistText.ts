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

const isSeparatorLine = (line: string): boolean => {
  const c = lineContent(line);
  return (c.startsWith('+') || c.startsWith('-')) && c.endsWith(SEPARATOR_SUFFIX);
};

/** Detect file EOL (CRLF if present, else LF). */
const detectEol = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** Insert a new enabled separator line after the `afterIndex`-th entry (0-based).
 *  Out-of-range afterIndex clamps to the last entry position. */
export function insertSeparatorAtIndexInText(
  text: string,
  name: string,
  afterIndex: number,
): string {
  const lines = splitLinesKeepEol(text);
  const entryLineIdx = [...lines.keys()].filter((i) => isEntryLine(lines[i]));
  const newLine = `+${name}${SEPARATOR_SUFFIX}${detectEol(text)}`;
  let insertAt: number;
  if (entryLineIdx.length === 0) {
    insertAt = lines.length;
  } else {
    const clamped = Math.max(0, Math.min(afterIndex, entryLineIdx.length - 1));
    insertAt = entryLineIdx[clamped] + 1;
  }
  lines.splice(insertAt, 0, newLine);
  return lines.join('');
}

/** Rename a separator in place, preserving its +/- prefix and every other byte. */
export function renameSeparatorInText(text: string, oldName: string, newName: string): string {
  for (const { start, end, contentEnd } of lineRanges(text)) {
    const content = text.slice(start, contentEnd);
    if (
      content === '+' + oldName + SEPARATOR_SUFFIX ||
      content === '-' + oldName + SEPARATOR_SUFFIX
    ) {
      const eol = text.slice(contentEnd, end);
      return text.slice(0, start) + text[start] + newName + SEPARATOR_SUFFIX + eol + text.slice(end);
    }
  }
  throw new Error(`Separator not found in modlist: ${oldName}`);
}

/** Remove a separator line only; its child mods are naturally promoted. */
export function deleteSeparatorInText(text: string, name: string): string {
  const lines = splitLinesKeepEol(text);
  const idx = lines.findIndex(
    (l) =>
      lineContent(l) === '+' + name + SEPARATOR_SUFFIX ||
      lineContent(l) === '-' + name + SEPARATOR_SUFFIX,
  );
  if (idx === -1) throw new Error(`Separator not found in modlist: ${name}`);
  lines.splice(idx, 1);
  return lines.join('');
}

/** Remove a mod's entry line entirely. Throws if absent; throws if the name resolves to a separator. */
export function removeModFromText(text: string, modName: string): string {
  const lines = splitLinesKeepEol(text);
  const idx = lines.findIndex(
    (l) => lineContent(l) === '+' + modName || lineContent(l) === '-' + modName,
  );
  if (idx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
  lines.splice(idx, 1);
  return lines.join('');
}

function ungroupedInsertAt(lines: string[]): number {
  const firstSepIdx = lines.findIndex(isSeparatorLine);
  if (firstSepIdx >= 0) {
    const lastUngrouped = [...lines.keys()].findLast(
      (i: number) => i < firstSepIdx && isEntryLine(lines[i]),
    );
    return lastUngrouped === undefined ? firstSepIdx : lastUngrouped + 1;
  }
  const last = [...lines.keys()].findLast((i: number) => isEntryLine(lines[i]));
  return last === undefined ? lines.length : last + 1;
}

function separatorSectionInsertAt(lines: string[], separatorName: string): number {
  const sepIdx = lines.findIndex(
    (l) =>
      lineContent(l) === '+' + separatorName + SEPARATOR_SUFFIX ||
      lineContent(l) === '-' + separatorName + SEPARATOR_SUFFIX,
  );
  if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);
  let lastChildIdx = sepIdx;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    if (isSeparatorLine(lines[i])) break;
    if (isEntryLine(lines[i])) lastChildIdx = i;
  }
  return lastChildIdx + 1;
}

/** Move a mod to the end of a separator's child section, or to the ungrouped section
 *  (before the first separator) when `separatorName` is null. */
export function moveModToSeparatorEndInText(
  text: string,
  modName: string,
  separatorName: string | null,
): string {
  const lines = splitLinesKeepEol(text);

  const modIdx = lines.findIndex(
    (l) => lineContent(l) === '+' + modName || lineContent(l) === '-' + modName,
  );
  if (modIdx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
  const [modLine] = lines.splice(modIdx, 1);

  const insertAt =
    separatorName === null
      ? ungroupedInsertAt(lines)
      : separatorSectionInsertAt(lines, separatorName);

  lines.splice(insertAt, 0, modLine);
  return lines.join('');
}

/** Move a separator and all its children as a block so the separator occupies
 *  entry-index `toIndex` among the remaining entries (after the block is removed). */
export function moveSeparatorBlockInText(
  text: string,
  separatorName: string,
  toIndex: number,
): string {
  const lines = splitLinesKeepEol(text);

  const sepIdx = lines.findIndex(
    (l) =>
      lineContent(l) === '+' + separatorName + SEPARATOR_SUFFIX ||
      lineContent(l) === '-' + separatorName + SEPARATOR_SUFFIX,
  );
  if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);

  // Extent of the block: sep line + everything up to (but not including) the next separator line
  const nextSep = lines.findIndex((l, i) => i > sepIdx && isSeparatorLine(l));
  const blockEnd = nextSep === -1 ? lines.length : nextSep;
  const block = lines.splice(sepIdx, blockEnd - sepIdx);

  // Insert at toIndex among remaining entry lines
  const entryLineIdx = [...lines.keys()].filter((i) => isEntryLine(lines[i]));
  const clamped = Math.max(0, Math.min(toIndex, entryLineIdx.length));
  let insertAt: number;
  if (clamped < entryLineIdx.length) {
    insertAt = entryLineIdx[clamped];
  } else if (entryLineIdx.length === 0) {
    insertAt = lines.length;
  } else {
    insertAt = entryLineIdx.at(-1)! + 1;
  }
  lines.splice(insertAt, 0, ...block);
  return lines.join('');
}

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
