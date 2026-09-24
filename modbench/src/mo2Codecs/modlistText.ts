// MO2's modlist.txt: `+`/`-` prefix an enabled/disabled mod, a `_separator`
// suffix marks a separator, and `*` (DLC/CC) and `#` lines are never surfaced.
// The top of the file is the winning end. Mutations splice the raw string.

import type { InstalledFileId } from './metaIni';
import { detectEol, lineContent, lineRanges, splitLinesKeepEol, stripBom, withBomPreserved } from './lineScan';

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

/** An end of mod order: the winning end is toward the top of modlist.txt. */
export type OrderEnd = 'winning' | 'losing';

const firstEntryLineAt = (lines: readonly string[]): number => {
  const first = lines.findIndex(isEntryLine);
  return first === -1 ? lines.length : first;
};

// The ungrouped mods follow the last separator line, so their winning end is directly after it.
function ungroupedWinningEndAt(lines: readonly string[]): number {
  const lastSeparator = [...lines.entries()].findLast(([, line]) => isSeparatorLine(line));
  return lastSeparator === undefined ? firstEntryLineAt(lines) : lastSeparator[0] + 1;
}

function separatorLineAt(lines: readonly string[], separatorName: string): number {
  const sepIdx = lines.findIndex((l) => matchesModLine(l, separatorName + SEPARATOR_SUFFIX));
  if (sepIdx === -1) throw new Error(`Separator not found in modlist: ${separatorName}`);
  return sepIdx;
}

// A separator trails the mods it holds, so its block runs back to the previous separator, or to
// `first` when none precedes it.
function blockStartOf<T>(items: readonly T[], sepIdx: number, isSeparator: (item: T) => boolean, first: number): number {
  const previous = items.slice(0, sepIdx).findLastIndex(isSeparator);
  return previous === -1 ? Math.min(first, sepIdx) : previous + 1;
}

// Starting at the first entry line, so a leading comment or blank line stays where it is.
const lineBlockStartAt = (lines: readonly string[], sepIdx: number): number =>
  blockStartOf(lines, sepIdx, isSeparatorLine, firstEntryLineAt(lines));

const separatorBlockStartAt = (lines: readonly string[], separatorName: string): number =>
  lineBlockStartAt(lines, separatorLineAt(lines, separatorName));

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

/** Where moved mods land: among a separator's mods, among the ungrouped mods, beside a mod, or
 *  at an end of the whole mod order. */
export type ModsPlace =
  | { kind: 'ungrouped' }
  | { kind: 'separator'; name: string }
  | { kind: 'mod'; name: string }
  | { kind: 'modOrder' };

/** Where moved separators land: beside a separator and its mods, or at an end of mod order. */
export type SeparatorsPlace = Extract<ModsPlace, { kind: 'separator' | 'modOrder' }>;

function modLineAt(lines: readonly string[], modName: string): number {
  const modIdx = lines.findIndex((l) => matchesModLine(l, modName));
  if (modIdx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
  return modIdx;
}

const lastEntryLineAt = (lines: readonly string[]): number => {
  const lastEntry = [...lines.entries()].findLast(([, line]) => isEntryLine(line));
  return lastEntry === undefined ? lines.length : lastEntry[0] + 1;
};

function modsInsertAt(lines: readonly string[], place: ModsPlace, end: OrderEnd): number {
  switch (place.kind) {
    case 'ungrouped': return end === 'losing' ? lastEntryLineAt(lines) : ungroupedWinningEndAt(lines);
    // A separator's line trails the mods it holds, so its losing end is directly above its line.
    case 'separator': return end === 'losing' ? separatorLineAt(lines, place.name) : separatorBlockStartAt(lines, place.name);
    case 'mod': return modLineAt(lines, place.name) + (end === 'losing' ? 1 : 0);
    case 'modOrder': return end === 'losing' ? lastEntryLineAt(lines) : firstEntryLineAt(lines);
  }
}

/** The mods land as one block, in their own order, at the `end` of the place's mods, or on the
 *  `end` side of the place's mod. Throws if the separator or the mod is absent. */
export function moveModsInText(text: string, modNames: readonly string[], place: ModsPlace, end: OrderEnd): string {
  return withBomPreserved(text, (bomless) => moveBlock(
    bomless,
    (line) => modNames.some((name) => matchesModLine(line, name)),
    (rest) => modsInsertAt(rest, place, end),
  ));
}

function separatorBlockLineIndices(lines: readonly string[], separatorNames: readonly string[]): Set<number> {
  const inBlock = new Set<number>();
  for (const [i, line] of lines.entries()) {
    if (!separatorNames.some((name) => matchesModLine(line, name + SEPARATOR_SUFFIX))) continue;
    for (let j = lineBlockStartAt(lines, i); j <= i; j++) inBlock.add(j);
  }
  return inBlock;
}

// A separator block landing at the losing end would take the ungrouped mods, so it stops on their
// winning side.
function separatorsInsertAt(lines: readonly string[], place: SeparatorsPlace, side: OrderEnd): number {
  if (place.kind === 'modOrder') return side === 'losing' ? ungroupedWinningEndAt(lines) : firstEntryLineAt(lines);
  return side === 'losing' ? separatorLineAt(lines, place.name) + 1 : separatorBlockStartAt(lines, place.name);
}

/** Each separator and the mods it holds land as one block, in their own order, directly on the
 *  `side` of the place's separator and its mods, or at that end of mod order. Throws if the
 *  separator is absent. */
export function moveSeparatorsInText(
  text: string, separatorNames: readonly string[], place: SeparatorsPlace, side: OrderEnd,
): string {
  return withBomPreserved(text, (bomless) => {
    const inBlock = separatorBlockLineIndices(splitLinesKeepEol(bomless), separatorNames);
    return moveBlock(bomless, (_line, i) => inBlock.has(i), (rest) => separatorsInsertAt(rest, place, side));
  });
}
