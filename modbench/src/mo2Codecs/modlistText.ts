// MO2's modlist.txt: `+`/`-` prefix an enabled/disabled mod, a `_separator`
// suffix marks a separator, and `*` (DLC/CC) and `#` lines are never surfaced.
// The top of the file is the winning end. Mutations splice the raw string.

import type { InstalledFileId } from './metaIni';
import { detectEol, insertIndexAmongEntries, lineContent, lineRanges, splitLinesKeepEol, stripBom, withBomPreserved } from './lineScan';

/** The per-profile mod list, one line per mod in Mod override order. */
export const MODLIST_FILE_NAME = 'modlist.txt';

/** The reserved origin (ADR-0012): MO2's own overwrite folder, the one name under `mods/`'s
 *  sibling set a modlist line may never take. The Instance adapter joins it to the instance root. */
export const OVERWRITE_DIR_NAME = 'overwrite';

export interface Mod {
  kind: 'mod';
  name: string;
  enabled: boolean;
  /** From mods/<name>/meta.ini; undefined when absent or empty. */
  version?: string;
  nexusId?: string;
  archiveFilename?: string;
  /** meta.ini's `[installedFiles]` array, in index order; undefined when the
   *  section is absent — the upgrade pick's exact-file match. */
  installedFiles?: readonly InstalledFileId[];
}

export interface Separator {
  kind: 'separator';
  /** Display name, with the trailing `_separator` marker stripped. */
  name: string;
  enabled: boolean;
}

export type ModlistEntry = Mod | Separator;

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

/** `afterIndex` is 0-based among entry lines, and clamps to the last one. `-1` inserts before the
 *  first entry line, the one position "after index i" cannot reach. */
export function insertSeparatorAtIndexInText(
  text: string,
  name: string,
  afterIndex: number,
): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const entryLineIdx = [...lines.entries()].filter(([, line]) => isEntryLine(line)).map(([i]) => i);
    const newLine = `+${name}${SEPARATOR_SUFFIX}${detectEol(bomless)}`;
    let insertAt: number;
    if (entryLineIdx.length === 0) {
      insertAt = lines.length;
    } else if (afterIndex < 0) {
      insertAt = entryLineIdx[0] ?? lines.length;
    } else {
      const clamped = Math.min(afterIndex, entryLineIdx.length - 1);
      const atClamped = entryLineIdx[clamped];
      insertAt = atClamped !== undefined ? atClamped + 1 : lines.length;
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
        // content matched `+`/`-` above, so its first character is that prefix, never absent.
        const prefix = content.slice(0, 1);
        return bomless.slice(0, start) + prefix + newName + SEPARATOR_SUFFIX + eol + bomless.slice(end);
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
    const prevLine = lines[insertAt - 1];
    if (insertAt > 0 && prevLine !== undefined && !/\r\n$|\r$|\n$/.test(prevLine)) {
      lines[insertAt - 1] = prevLine + eol; // EOL-terminate the line we insert after
    }
    lines.splice(insertAt, 0, newLine);
    return lines.join('');
  });
}

const RESERVED_DIR_NAMES = new Set([OVERWRITE_DIR_NAME]);

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
function ungroupedInsertAt(lines: readonly string[]): number {
  const lastEntry = [...lines.entries()].findLast(([, line]) => isEntryLine(line));
  return lastEntry === undefined ? lines.length : lastEntry[0] + 1;
}

function separatorLineAt(lines: readonly string[], separatorName: string): number {
  const sepIdx = lines.findIndex((l) => matchesModLine(l, separatorName + SEPARATOR_SUFFIX));
  if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);
  return sepIdx;
}

// Only the file's last line may lack an EOL, so every other line gets one.
function moveBlock(
  bomless: string, isMoved: (line: string, index: number) => boolean, at: (rest: readonly string[]) => number,
): string {
  const lines = splitLinesKeepEol(bomless);
  const block = lines.filter((line, i) => isMoved(line, i));
  const rest = lines.filter((line, i) => !isMoved(line, i));
  rest.splice(at(rest), 0, ...block);
  const eol = detectEol(bomless);
  return rest.map((line, i) => (i < rest.length - 1 && lineContent(line) === line ? line + eol : line)).join('');
}

/** Where moved mods land. A separator's line trails the mods it holds, so its losing-most mods
 *  sit directly above its line. */
export type ModsPlace = { kind: 'ungrouped' } | { kind: 'separator'; name: string };

/** The mods land as one block, in their own order: as the losing-most mods of a separator, or
 *  after the last entry line, the losing-most of the ungrouped mods. Throws if the separator is
 *  absent. */
export function moveModsInText(text: string, modNames: readonly string[], place: ModsPlace): string {
  return withBomPreserved(text, (bomless) => moveBlock(
    bomless,
    (line) => modNames.some((name) => matchesModLine(line, name)),
    (rest) => (place.kind === 'ungrouped' ? ungroupedInsertAt(rest) : separatorLineAt(rest, place.name)),
  ));
}

// A separator's block runs back to the previous separator's line, or to the first entry line, so
// a leading comment or blank line stays where it is.
function separatorBlockLineIndices(lines: readonly string[], separatorNames: readonly string[]): Set<number> {
  const inBlock = new Set<number>();
  let blockStart = lines.findIndex(isEntryLine);
  for (const [i, line] of lines.entries()) {
    if (!isSeparatorLine(line)) continue;
    if (separatorNames.some((name) => matchesModLine(line, name + SEPARATOR_SUFFIX))) {
      for (let j = blockStart; j <= i; j++) inBlock.add(j);
    }
    blockStart = i + 1;
  }
  return inBlock;
}

/** Each separator and the mods it holds land as one block, in their own order, directly on the
 *  losing side of the target separator's line. Throws if the target is absent. */
export function moveSeparatorsInText(text: string, separatorNames: readonly string[], targetName: string): string {
  return withBomPreserved(text, (bomless) => {
    const inBlock = separatorBlockLineIndices(splitLinesKeepEol(bomless), separatorNames);
    return moveBlock(bomless, (_line, i) => inBlock.has(i), (rest) => separatorLineAt(rest, targetName) + 1);
  });
}

/** The entries one separator wraps, itself last — the same block
 *  {@link moveSeparatorBlockInText} splices, named rather than moved. */
export function separatorBlockNames(entries: readonly ModlistEntry[], separatorName: string): string[] {
  const sepIdx = entries.findIndex((e) => e.kind === 'separator' && e.name === separatorName);
  if (sepIdx < 0) return [separatorName];
  let blockStart = 0;
  for (const [i, entry] of [...entries.entries()].slice(0, sepIdx).reverse()) {
    if (entry.kind === 'separator') { blockStart = i + 1; break; }
  }
  return [...entries.slice(blockStart, sepIdx).map((e) => e.name), separatorName];
}

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
    for (const [i, line] of [...lines.entries()].slice(0, sepIdx).reverse()) {
      if (isSeparatorLine(line)) {
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
    const moved = lines.find((l) => matchesModLine(l, modName));
    if (moved === undefined) throw new Error(`Mod not found in modlist: ${modName}`);
    lines.splice(lines.indexOf(moved), 1);

    const insertAt = insertIndexAmongEntries(lines, isEntryLine, toIndex);
    lines.splice(insertAt, 0, moved);
    return lines.join('');
  });
}
