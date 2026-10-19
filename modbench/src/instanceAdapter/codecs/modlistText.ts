// MO2's modlist.txt: `-` prefixes a disabled mod, `+` or no prefix an enabled one, a
// `_separator` suffix marks a separator, and `*` (unmanaged) and `#` lines are never surfaced.
// The top of the file is the winning end. Mutations edit the lines.

import type { EntryRef, ModlistEntry, MovePlace, OrderEnd, SeparatorsPlace } from '../instanceAdapter';
import { firstLines } from '../../loadOrderFileCodec/firstLines';
import { editLines, entryLineIndices, stripBom } from '../../loadOrderFileCodec/lineScan';

/** The per-profile mod list, one line per mod in Mod override order. */
export const MODLIST_FILE_NAME = 'modlist.txt';

/** MO2's overwrite folder, which no modlist line takes. */
export const OVERWRITE_DIR_NAME = 'overwrite';

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

interface ModlistLine { readonly prefix: string; readonly name: string }

// A line as MO2 reads it (profile.cpp): no prefix is an enabled mod, and the name is trimmed.
// A `*` line is MO2's unmanaged mod, which is no row (mods.md); `#` and blank lines are no mod.
function readLine(line: string): ModlistLine | undefined {
  if (line.startsWith('#') || line.startsWith('*')) return undefined;
  const prefix = '+-'.includes(line[0] ?? '#') ? line.slice(0, 1) : '';
  const name = line.slice(prefix.length).trim();
  return name === '' ? undefined : { prefix, name };
}

const nameOfLine = (line: string): string | undefined => readLine(line)?.name;

const matchesModLine = (line: string, name: string): boolean => nameOfLine(line) === name;

/** File order, so the winning end comes first. A name MO2 reads twice takes the state of the last line
 *  that differs from the others in case; an exact repeat of an earlier line is not read. */
export function parseModlist(text: string): ModlistEntry[] {
  const lines = stripBom(text).split(/\r\n|\r|\n/).flatMap((raw) => readLine(raw) ?? []);
  const seen = new Set<string>();
  const stateOf = new Map<string, boolean>();
  for (const { prefix, name } of lines) {
    if (seen.has(name)) continue;
    seen.add(name);
    stateOf.set(modNameKey(name), prefix !== '-');
  }
  return lines.map(({ name }) => ({ ...entryNamed(name), enabled: stateOf.get(modNameKey(name)) ?? true }));
}

const isEntryLine = (line: string): boolean => readLine(line) !== undefined;

const isSeparatorLine = (line: string): boolean => nameOfLine(line)?.endsWith(SEPARATOR_SUFFIX) ?? false;

/** Throws if the mod is absent. */
export function setEnabledInText(text: string, modName: string, enabled: boolean): string {
  return editLines(text, (lines) => {
    modLineAt(lines, modName);
    return lines.map((line) => {
      const read = readLine(line);
      if (read === undefined || modNameKey(read.name) !== modNameKey(modName) || (read.prefix !== '-') === enabled) return line;
      return (enabled ? '+' : '-') + read.name;
    });
  });
}

export const modLineKey = ({ kind, name }: EntryRef): string => `${kind}:${modNameKey(name)}`;

/** Directly after a mod anchor, and before the first mod of a separator anchor's own group, taking none.
 *  Throws if the anchor is absent. */
export function insertSeparatorBesideInText(text: string, name: string, anchor: EntryRef): string {
  return editLines(text, (lines) => {
    const insertAt = anchor.kind === 'mod' ? modLineAt(lines, anchor.name) + 1 : separatorBlockStartAt(lines, anchor.name);
    lines.splice(insertAt, 0, `+${separatorModName(name)}`);
    return lines;
  });
}

export function renameModLineInText(text: string, oldModName: string, newModName: string): string {
  return editLines(text, (lines) => {
    const idx = modLineAt(lines, oldModName);
    lines[idx] = (readLine(lines[idx] ?? '')?.prefix ?? '') + newModName;
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

// A separator trails the mods it holds, so its block runs back to the previous separator the
// reading shows, or to the first entry line when none precedes it. A repeated line is no boundary.
function lineBlockStartAt(lines: readonly string[], sepIdx: number): number {
  const repeats = new Set(firstLines(entryLineIndices(lines, isEntryLine), (at) => modLineKey(entryNamed(nameOfLine(lines[at] ?? '') ?? ''))).repeats);
  const previous = lines.slice(0, sepIdx).findLastIndex((line, at) => isSeparatorLine(line) && !repeats.has(at));
  // Starting at the first entry line, so a leading comment or blank line stays where it is.
  return previous === -1 ? Math.min(firstEntryLineAt(lines), sepIdx) : previous + 1;
}

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
