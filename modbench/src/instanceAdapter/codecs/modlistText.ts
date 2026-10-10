// MO2's modlist.txt: `+`/`-` prefix an enabled/disabled mod, a `_separator`
// suffix marks a separator, and `*` (DLC/CC) and `#` lines are never surfaced.
// The top of the file is the winning end. Mutations edit the lines.

import type { EntryRef, ModlistEntry, MovePlace, OrderEnd, SeparatorsPlace } from '../instanceAdapter';
import { editLines, stripBom } from '../../loadOrderFileCodec/lineScan';

/** The per-profile mod list, one line per mod in Mod override order. */
export const MODLIST_FILE_NAME = 'modlist.txt';

/** MO2's overwrite folder, a reserved origin (ADR-0012) that no modlist line takes.
 *  The Instance adapter joins it to the instance root. */
export const OVERWRITE_DIR_NAME = 'overwrite';

/** The origin of Overwrite's files. It ends in `/`, which no folder name holds, so no mod shares
 *  it. Equal to mEdit's PluginOrigin.Overwrite. */
export const OVERWRITE_ORIGIN = `${OVERWRITE_DIR_NAME}/`;

const SEPARATOR_SUFFIX = '_separator';

/** MO2's own name for a separator: what its line carries after the prefix, and its folder's name
 *  under `mods/`. */
export const separatorModName = (name: string): string => name + SEPARATOR_SUFFIX;

/** MO2 keys mods and separators by name without case (modinfo.cpp, FileNameComparator). */
export const modNameKey = (name: string): string => name.toLowerCase();

/** The entry MO2's own name for it holds, a line's or a folder's alike: a separator's carries the
 *  suffix. */
export const entryNamed = (modName: string): EntryRef => (modName.endsWith(SEPARATOR_SUFFIX)
  ? { kind: 'separator', name: modName.slice(0, -SEPARATOR_SUFFIX.length) }
  : { kind: 'mod', name: modName });

// Deliberately state-insensitive: both prefixes match, and a caller that needs to
// know which one did reads the prefix itself.
const matchesModLine = (line: string, name: string): boolean => line === '+' + name || line === '-' + name;

/** File order, so the winning end comes first. Only `+`/`-` lines are surfaced;
 *  the rest carry no meaning here and are preserved on write. */
export function parseModlist(text: string): ModlistEntry[] {
  const entries: ModlistEntry[] = [];
  for (const raw of stripBom(text).split(/\r\n|\r|\n/)) {
    const prefix = raw[0];
    if (prefix !== '+' && prefix !== '-') continue; // comment, *, blank
    entries.push({ ...entryNamed(raw.slice(1)), enabled: prefix === '+' });
  }
  return entries;
}

const isEntryLine = (line: string): boolean => line[0] === '+' || line[0] === '-';

const isSeparatorLine = (line: string): boolean => isEntryLine(line) && line.endsWith(SEPARATOR_SUFFIX);

/** Throws if the mod is absent. */
export function setEnabledInText(text: string, modName: string, enabled: boolean): string {
  return editLines(text, (lines) => {
    const idx = modLineAt(lines, modName);
    lines[idx] = (enabled ? '+' : '-') + (lines[idx] ?? '').slice(1);
    return lines;
  });
}

/** `afterIndex` is 0-based among entry lines, and clamps to the last one. `-1` inserts before the
 *  first entry line, the one position "after index i" cannot reach. */
export function insertSeparatorAtIndexInText(text: string, name: string, afterIndex: number): string {
  return editLines(text, (lines) => {
    const entryLineIdx = [...lines.entries()].filter(([, line]) => isEntryLine(line)).map(([i]) => i);
    const anchor = entryLineIdx[Math.max(0, Math.min(afterIndex, entryLineIdx.length - 1))];
    const insertAt = anchor === undefined ? lines.length : afterIndex < 0 ? anchor : anchor + 1;
    lines.splice(insertAt, 0, `+${separatorModName(name)}`);
    return lines;
  });
}

export function renameModLineInText(text: string, oldModName: string, newModName: string): string {
  return editLines(text, (lines) => {
    const idx = modLineAt(lines, oldModName);
    lines[idx] = (lines[idx] ?? '').slice(0, 1) + newModName;
    return lines;
  });
}

export const renameSeparatorInText = (text: string, oldName: string, newName: string): string =>
  renameModLineInText(text, separatorModName(oldName), separatorModName(newName));

/** Removes the separator line only; the mods it wrapped join the section above. */
export function deleteSeparatorInText(text: string, name: string): string {
  return editLines(text, (lines) => {
    lines.splice(separatorLineAt(lines, name), 1);
    return lines;
  });
}

/** The winning end is where MO2 puts a freshly installed mod. Inserted disabled,
 *  so it cannot silently change what the game sees before the user enables it. */
export function insertModAtWinningEnd(text: string, modName: string): string {
  return editLines(text, (lines) => {
    lines.splice(firstEntryLineAt(lines), 0, `-${modName}`);
    return lines;
  });
}

/** Throws if the name is absent, or resolves to a separator. */
export function removeModFromText(text: string, modName: string): string {
  return editLines(text, (lines) => {
    lines.splice(modLineAt(lines, modName), 1);
    return lines;
  });
}

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
  const sepIdx = lines.findIndex((l) => matchesModLine(l, separatorModName(separatorName)));
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

function moveBlock(
  lines: readonly string[], isMoved: (line: string, index: number) => boolean, at: (rest: readonly string[]) => number,
): string[] {
  const block = lines.filter((line, i) => isMoved(line, i));
  const rest = lines.filter((line, i) => !isMoved(line, i));
  rest.splice(at(rest), 0, ...block);
  return rest;
}

function modLineAt(lines: readonly string[], modName: string): number {
  const modIdx = lines.findIndex((l) => matchesModLine(l, modName));
  if (modIdx === -1) throw new Error(`Mod not found in modlist: ${modName}`);
  return modIdx;
}

const lastEntryLineAt = (lines: readonly string[]): number => {
  const lastEntry = [...lines.entries()].findLast(([, line]) => isEntryLine(line));
  return lastEntry === undefined ? lines.length : lastEntry[0] + 1;
};

function modsInsertAt(lines: readonly string[], place: MovePlace, end: OrderEnd): number {
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
export function moveModsInText(text: string, modNames: readonly string[], place: MovePlace, end: OrderEnd): string {
  return editLines(text, (lines) => moveBlock(
    lines,
    (line) => modNames.some((name) => matchesModLine(line, name)),
    (rest) => modsInsertAt(rest, place, end),
  ));
}

function separatorBlockLineIndices(lines: readonly string[], separatorNames: readonly string[]): Set<number> {
  const inBlock = new Set<number>();
  for (const [i, line] of lines.entries()) {
    if (!separatorNames.some((name) => matchesModLine(line, separatorModName(name)))) continue;
    for (let j = lineBlockStartAt(lines, i); j <= i; j++) inBlock.add(j);
  }
  return inBlock;
}

// A separator block landing at the losing end would take the ungrouped mods, so it stops on their
// winning side.
function separatorsInsertAt(lines: readonly string[], place: SeparatorsPlace, end: OrderEnd): number {
  if (place.kind === 'modOrder') return end === 'losing' ? ungroupedWinningEndAt(lines) : firstEntryLineAt(lines);
  return end === 'losing' ? separatorLineAt(lines, place.name) + 1 : separatorBlockStartAt(lines, place.name);
}

/** Each separator and its mods land as one block, in their own order, directly on the `end` side
 *  of the place's separator and its mods, or at that end of mod order. Throws if the separator is
 *  absent. */
export function moveSeparatorsInText(
  text: string, separatorNames: readonly string[], place: SeparatorsPlace, end: OrderEnd,
): string {
  return editLines(text, (lines) => {
    const inBlock = separatorBlockLineIndices(lines, separatorNames);
    return moveBlock(lines, (_line, i) => inBlock.has(i), (rest) => separatorsInsertAt(rest, place, end));
  });
}
