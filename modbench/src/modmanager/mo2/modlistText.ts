// MO2's modlist.txt: `+`/`-` prefix an enabled/disabled mod, a `_separator`
// suffix marks a separator, and `*` (DLC/CC) and `#` lines are never surfaced.
// The top of the file is the winning end. Mutations splice the raw string.

import type { ModlistEntry } from '../model';
import { detectEol, insertIndexAmongEntries, lineContent, lineRanges, splitLinesKeepEol, stripBom, withBomPreserved } from './lineScan';

const SEPARATOR_SUFFIX = '_separator';

// Deliberately state-insensitive: both prefixes match, and a caller that needs to
// know which one did reads the prefix itself.
const matchesModLine = (line: string, name: string): boolean =>
  lineContent(line) === '+' + name || lineContent(line) === '-' + name;

/** File order, so the winning end comes first. Only `+`/`-` lines are surfaced;
 *  the rest carry no meaning here and are preserved on write. */
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

function findModPrefixIndex(text: string, modName: string): number {
  for (const { start, contentEnd } of lineRanges(text)) {
    if (matchesModLine(text.slice(start, contentEnd), modName)) return start;
  }
  return -1;
}

/** Throws if the mod is absent. */
export function setEnabledInText(text: string, modName: string, enabled: boolean): string {
  return withBomPreserved(text, (bomless) => {
    const idx = findModPrefixIndex(bomless, modName);
    if (idx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
    const desired = enabled ? '+' : '-';
    if (bomless[idx] === desired) return bomless;
    return bomless.slice(0, idx) + desired + bomless.slice(idx + 1);
  });
}

const isEntryLine = (line: string): boolean => {
  const c = lineContent(line)[0];
  return c === '+' || c === '-';
};

const isSeparatorLine = (line: string): boolean => {
  const c = lineContent(line);
  return (c.startsWith('+') || c.startsWith('-')) && c.endsWith(SEPARATOR_SUFFIX);
};

/** `afterIndex` is 0-based among entry lines, and clamps to the last one. */
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

export function renameSeparatorInText(text: string, oldName: string, newName: string): string {
  return withBomPreserved(text, (bomless) => {
    for (const { start, end, contentEnd } of lineRanges(bomless)) {
      const content = bomless.slice(start, contentEnd);
      if (matchesModLine(content, oldName + SEPARATOR_SUFFIX)) {
        const eol = bomless.slice(contentEnd, end);
        return bomless.slice(0, start) + bomless[start] + newName + SEPARATOR_SUFFIX + eol + bomless.slice(end);
      }
    }
    throw new Error(`Separator not found in modlist: ${oldName}`);
  });
}

/** Removes the separator line only; the mods it wrapped join the section above. */
export function deleteSeparatorInText(text: string, name: string): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const idx = lines.findIndex((l) => matchesModLine(l, name + SEPARATOR_SUFFIX));
    if (idx === -1) throw new Error(`Separator not found in modlist: ${name}`);
    lines.splice(idx, 1);
    return lines.join('');
  });
}

/** The winning end is where MO2 puts a freshly installed mod. Inserted disabled,
 *  so it cannot silently change what the game sees before the user enables it. */
export function insertModAtWinningEnd(text: string, modName: string): string {
  return withBomPreserved(text, (bomless) => {
    const eol = detectEol(bomless);
    const newLine = `-${modName}${eol}`;
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

/** Excludes `overwrite` and the `<name>_separator` marker folders MO2 writes,
 *  neither of which is a mod. Sorted, for a deterministic registration order. */
export function unlistedModNames(dirNames: string[], entries: ModlistEntry[]): string[] {
  // Separators must not contribute to `registered` under their bare name: users
  // name separators after what they group, so a real `mods/<name>/` folder
  // sharing that name would silently stop being offered for registration.
  const registered = new Set(
    entries.filter((e) => e.kind !== 'separator').map((e) => e.name),
  );
  return dirNames
    .filter(
      (name) =>
        !RESERVED_DIR_NAMES.has(name) && !name.endsWith(SEPARATOR_SUFFIX) && !registered.has(name),
    )
    .sort((a, b) => a.localeCompare(b));
}

/** Entries whose folder is absent from the listing — deleted outside Modbench.
 *  Separators are never dead here: their on-disk form is a marker folder, which
 *  this listing does not describe. In modlist order. */
export function deadModEntryNames(dirNames: string[], entries: ModlistEntry[]): string[] {
  const present = new Set(dirNames);
  return entries
    .filter((e) => e.kind === 'mod' && !present.has(e.name))
    .map((e) => e.name);
}

/** Throws if the name is absent, or resolves to a separator. */
export function removeModFromText(text: string, modName: string): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const idx = lines.findIndex((l) => matchesModLine(l, modName));
    if (idx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
    lines.splice(idx, 1);
    return lines.join('');
  });
}

// Ungrouped means "after the last separator" — the tail of the entry lines —
// never a position relative to the first separator.
function ungroupedInsertAt(lines: string[]): number {
  const last = [...lines.keys()].findLast((i: number) => isEntryLine(lines[i]));
  return last === undefined ? lines.length : last + 1;
}

// A separator's section is the mods that PRECEDE it; its last member sits
// immediately above the separator's own line, so the insert point for "append to
// this section" is simply the separator line's own index.
function separatorSectionInsertAt(lines: string[], separatorName: string): number {
  const sepIdx = lines.findIndex((l) => matchesModLine(l, separatorName + SEPARATOR_SUFFIX));
  if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);
  return sepIdx;
}

/** The end of a separator's section is immediately above the separator's own
 *  line. A null `separatorName` means the ungrouped tail of the file. */
export function moveModToSeparatorEndInText(
  text: string,
  modName: string,
  separatorName: string | null,
): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);

    const modIdx = lines.findIndex((l) => matchesModLine(l, modName));
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

/** The block is the separator plus the mods it wraps; `toIndex` counts the
 *  entries remaining once that block is removed. */
export function moveSeparatorBlockInText(
  text: string,
  separatorName: string,
  toIndex: number,
): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);

    const sepIdx = lines.findIndex((l) => matchesModLine(l, separatorName + SEPARATOR_SUFFIX));
    if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);

    // A separator trails the mods it wraps, so the block runs back to the previous
    // separator, or to the first entry line — falling back to line 0 instead would
    // sweep a leading comment or blank line into the block.
    let prevSepIdx = -1;
    for (let i = sepIdx - 1; i >= 0; i--) {
      if (isSeparatorLine(lines[i])) {
        prevSepIdx = i;
        break;
      }
    }
    const blockStart = prevSepIdx >= 0 ? prevSepIdx + 1 : lines.findIndex(isEntryLine);
    const block = lines.splice(blockStart, sepIdx - blockStart + 1);

    const insertAt = insertIndexAmongEntries(lines, isEntryLine, toIndex);
    lines.splice(insertAt, 0, ...block);
    return lines.join('');
  });
}

/** `toIndex` counts the entry lines with the moved mod already removed, and
 *  clamps to the last slot. Non-entry lines keep their relative positions. */
export function moveModInText(text: string, modName: string, toIndex: number): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const srcLine = lines.findIndex((l) => matchesModLine(l, modName));
    if (srcLine === -1) throw new Error(`Mod not found in modlist: ${modName}`);

    const [moved] = lines.splice(srcLine, 1);
    const insertAt = insertIndexAmongEntries(lines, isEntryLine, toIndex);
    lines.splice(insertAt, 0, moved);
    return lines.join('');
  });
}
