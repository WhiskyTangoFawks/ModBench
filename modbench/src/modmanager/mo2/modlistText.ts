// Pure, byte-faithful text transforms over an MO2 profile's modlist.txt.
//
// modlist.txt lines (top of file = winning end; bottom = losing end):
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
const BOM = '\uFEFF';

const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

/** The BOM is a whole-file property (always at absolute position 0), never a
 *  line's. Every surgical edit strips it up front, edits the bomless text
 *  with the (BOM-unaware) helpers below, then re-prepends it — so the BOM
 *  stays pinned to position 0 even when the line that carried it is edited,
 *  moved, or removed. */
function withBomPreserved(text: string, edit: (bomless: string) => string): string {
  if (!text.startsWith(BOM)) return edit(text);
  return BOM + edit(stripBom(text));
}

/** Parse modlist.txt into the ordered model view (file order; top = winning end).
 *  Only +/- mod and separator lines are surfaced; comment/*-prefixed/blank
 *  lines carry no model meaning and are ignored (but preserved on write). */
export function parseModlist(text: string): ModlistEntry[] {
  const entries: ModlistEntry[] = [];
  const withoutBom = stripBom(text); // model view only; write path preserves the BOM byte
  for (const raw of withoutBom.split(/\r\n|\r|\n/)) {
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
  return withBomPreserved(text, (bomless) => {
    const idx = findModPrefixIndex(bomless, modName);
    if (idx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
    const desired = enabled ? '+' : '-';
    if (bomless[idx] === desired) return bomless;
    return bomless.slice(0, idx) + desired + bomless.slice(idx + 1);
  });
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
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const entryLineIdx = [...lines.keys()].filter((i) => isEntryLine(lines[i]));
    const newLine = `+${name}${SEPARATOR_SUFFIX}${detectEol(bomless)}`;
    let insertAt: number;
    if (entryLineIdx.length === 0) {
      insertAt = lines.length;
    } else {
      const clamped = Math.max(0, Math.min(afterIndex, entryLineIdx.length - 1));
      insertAt = entryLineIdx[clamped] + 1;
    }
    lines.splice(insertAt, 0, newLine);
    return lines.join('');
  });
}

/** Rename a separator in place, preserving its +/- prefix and every other byte. */
export function renameSeparatorInText(text: string, oldName: string, newName: string): string {
  return withBomPreserved(text, (bomless) => {
    for (const { start, end, contentEnd } of lineRanges(bomless)) {
      const content = bomless.slice(start, contentEnd);
      if (
        content === '+' + oldName + SEPARATOR_SUFFIX ||
        content === '-' + oldName + SEPARATOR_SUFFIX
      ) {
        const eol = bomless.slice(contentEnd, end);
        return bomless.slice(0, start) + bomless[start] + newName + SEPARATOR_SUFFIX + eol + bomless.slice(end);
      }
    }
    throw new Error(`Separator not found in modlist: ${oldName}`);
  });
}

/** Remove a separator line only; its child mods are naturally promoted. */
export function deleteSeparatorInText(text: string, name: string): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const idx = lines.findIndex(
      (l) =>
        lineContent(l) === '+' + name + SEPARATOR_SUFFIX ||
        lineContent(l) === '-' + name + SEPARATOR_SUFFIX,
    );
    if (idx === -1) throw new Error(`Separator not found in modlist: ${name}`);
    lines.splice(idx, 1);
    return lines.join('');
  });
}

/** Insert a disabled mod line at the winning end — the first entry line (top of
 *  file), where MO2 places a freshly installed mod. It lands
 *  below any leading comment/blank/`*` lines but above the first `+`/`-` entry,
 *  disabled so it never silently changes the load until enabled. Preserves every
 *  existing byte and uses the file's own EOL (CRLF if present, else LF). */
export function insertModAtWinningEnd(text: string, modName: string): string {
  return withBomPreserved(text, (bomless) => {
    const eol = detectEol(bomless);
    const newLine = `-${modName}${eol}`;
    if (bomless === '') return newLine;
    const lines = splitLinesKeepEol(bomless);
    const firstEntry = lines.findIndex(isEntryLine);
    const insertAt = firstEntry === -1 ? lines.length : firstEntry;
    if (insertAt > 0 && !/\r\n$|\r$|\n$/.test(lines[insertAt - 1])) {
      lines[insertAt - 1] += eol; // EOL-terminate the line we insert after
    }
    lines.splice(insertAt, 0, newLine);
    return lines.join('');
  });
}

const RESERVED_DIR_NAMES = new Set(['overwrite']);

/** Which `mods/` folder names (from a directory listing) have no modlist.txt
 *  entry yet, given the currently parsed `entries`. Excludes `overwrite`
 *  (not a mod) and separator marker folders (`<name>_separator`, MO2's
 *  on-disk record of a separator — already represented by a `separator`
 *  entry, never a mod). Sorted for deterministic registration order. */
export function unlistedModNames(dirNames: string[], entries: ModlistEntry[]): string[] {
  const registered = new Set(
    entries.map((e) => (e.kind === 'separator' ? `${e.name}${SEPARATOR_SUFFIX}` : e.name)),
  );
  return dirNames
    .filter(
      (name) =>
        !RESERVED_DIR_NAMES.has(name) && !name.endsWith(SEPARATOR_SUFFIX) && !registered.has(name),
    )
    .sort((a, b) => a.localeCompare(b));
}

/** Remove a mod's entry line entirely. Throws if absent; throws if the name resolves to a separator. */
export function removeModFromText(text: string, modName: string): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const idx = lines.findIndex(
      (l) => lineContent(l) === '+' + modName || lineContent(l) === '-' + modName,
    );
    if (idx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
    lines.splice(idx, 1);
    return lines.join('');
  });
}

// Ungrouped means "after the last separator" — the file's tail among entry
// lines — never a position relative to the first separator (#107).
function ungroupedInsertAt(lines: string[]): number {
  const last = [...lines.keys()].findLast((i: number) => isEntryLine(lines[i]));
  return last === undefined ? lines.length : last + 1;
}

// A separator's section is the mods that PRECEDE it (#107); its last member sits
// immediately above the separator's own line, so the insert point for "append to
// this section" is simply the separator line's own index.
function separatorSectionInsertAt(lines: string[], separatorName: string): number {
  const sepIdx = lines.findIndex(
    (l) =>
      lineContent(l) === '+' + separatorName + SEPARATOR_SUFFIX ||
      lineContent(l) === '-' + separatorName + SEPARATOR_SUFFIX,
  );
  if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);
  return sepIdx;
}

/** Move a mod to the end of a separator's child section (immediately preceding
 *  the separator's own line — #107), or to the ungrouped section (the file's
 *  tail, after the last entry) when `separatorName` is null. */
export function moveModToSeparatorEndInText(
  text: string,
  modName: string,
  separatorName: string | null,
): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);

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
  });
}

/** Move a separator and all its children as a block so the separator occupies
 *  entry-index `toIndex` among the remaining entries (after the block is removed). */
export function moveSeparatorBlockInText(
  text: string,
  separatorName: string,
  toIndex: number,
): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);

    const sepIdx = lines.findIndex(
      (l) =>
        lineContent(l) === '+' + separatorName + SEPARATOR_SUFFIX ||
        lineContent(l) === '-' + separatorName + SEPARATOR_SUFFIX,
    );
    if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);

    // Extent of the block: everything back to (but not including) the previous
    // separator line, or the file's first entry line if none, up to and
    // including the sep's own line — the separator trails its real (preceding)
    // members (#107). Falling back to line 0 instead of the first entry would
    // sweep a leading comment/blank line into the block.
    let prevSepIdx = -1;
    for (let i = sepIdx - 1; i >= 0; i--) {
      if (isSeparatorLine(lines[i])) {
        prevSepIdx = i;
        break;
      }
    }
    const blockStart = prevSepIdx >= 0 ? prevSepIdx + 1 : lines.findIndex(isEntryLine);
    const block = lines.splice(blockStart, sepIdx - blockStart + 1);

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
  });
}

/** Move a mod's line so it occupies entry-index `toIndex` among the +/- entry
 *  lines (top of file = winning end), counting the entries *with the moved mod
 *  removed*. Out-of-range clamps to the last entry slot. Non-entry lines
 *  (comment, *) keep their relative position; bytes are preserved. */
export function moveModInText(text: string, modName: string, toIndex: number): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
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
  });
}
