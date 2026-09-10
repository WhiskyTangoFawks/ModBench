// MO2's plugins.txt: a leading `*` marks enabled, `#` lines and blanks carry no
// meaning, and the bottom of the file is winning-most. Mutations splice the raw
// string, so EOLs, BOM and unmodelled lines survive untouched.

import { detectEol, insertIndexAmongEntries, lineContent, lineRanges, splitLinesKeepEol, stripBom, withBomPreserved } from './lineScan';

/** A single plugins.txt line (a plugin file), in Plugin load order. The `*`
 *  prefix (MO2's enabled marker) is modelled as `enabled`; the marker itself is
 *  never surfaced in `name`. Distinct from a Mod: plugins.txt has no separators. */
export interface PluginEntry {
  name: string;
  enabled: boolean;
}

// MO2 never writes padded lines, but a hand-edited plugins.txt can, so reads trim.
// Writes cannot use this: it collapses away the marker's real byte offset.
const trimmedEntryContent = (line: string): string => lineContent(line).trim();

const isEntryLine = (line: string): boolean => {
  const c = trimmedEntryContent(line);
  return c.length > 0 && !c.startsWith('#');
};

const isEnabledEntry = (line: string): boolean => trimmedEntryContent(line).startsWith('*');

// `PluginEntry.name` is a matching key, so a hand-padded line must resolve to the
// same name as a clean one — neither the padding nor the `*` may leak into it.
const pluginNameOf = (line: string): string => {
  const c = trimmedEntryContent(line);
  return c.startsWith('*') ? c.slice(1) : c;
};

/** Each name's 0-based line-order index — the `load_order_idx` slot ADR-0044 derives from —
 *  keyed by exact case. A caller matching another file's names case-insensitively folds the
 *  keys itself. */
export function pluginSlots(names: readonly string[]): Map<string, number> {
  return new Map(names.map((name, slot) => [name, slot] as const));
}

/** Only entry lines are surfaced; comment and blank lines are ignored here and
 *  preserved on write. */
export function parsePlugins(text: string): PluginEntry[] {
  const entries: PluginEntry[] = [];
  for (const raw of stripBom(text).split(/\r\n|\r|\n/)) {
    if (!isEntryLine(raw)) continue;
    entries.push({ name: pluginNameOf(raw), enabled: isEnabledEntry(raw) });
  }
  return entries;
}

// Lands at the winning end but before any trailing comment/blank lines, matching
// where `movePluginsInText` puts a block moved to the end. Caller has already
// established the name has no entry line.
function appendEntryLine(bomless: string, pluginName: string, enabled: boolean): string {
  const eol = detectEol(bomless);
  const line = `${enabled ? '*' : ''}${pluginName}${eol}`;
  if (bomless.length === 0) return line;

  const lines = splitLinesKeepEol(bomless);
  const last = lines[lines.length - 1];
  if (!/\r\n$|\r$|\n$/.test(last)) lines[lines.length - 1] = last + eol;

  const entryLineIdx = [...lines.keys()].filter((i) => isEntryLine(lines[i]));
  const insertAt = entryLineIdx.length === 0 ? lines.length : entryLineIdx.at(-1)! + 1;
  lines.splice(insertAt, 0, line);
  return lines.join('');
}

/** A name with no entry line has no marker to toggle, and leaves the text
 *  untouched rather than throwing. */
export function setPluginEnabledInText(text: string, pluginName: string, enabled: boolean): string {
  return withBomPreserved(text, (bomless) => {
    for (const { start, contentEnd } of lineRanges(bomless)) {
      const content = bomless.slice(start, contentEnd);
      if (!isEntryLine(content) || pluginNameOf(content) !== pluginName) continue;
      const isEnabled = isEnabledEntry(content);
      if (isEnabled === enabled) return bomless; // already in the requested state
      // The marker is at the first non-whitespace character, not at `start`: a
      // hand-padded line would otherwise be spliced in its padding.
      const markerAt = start + (content.length - content.trimStart().length);
      if (enabled) return bomless.slice(0, markerAt) + '*' + bomless.slice(markerAt);
      return bomless.slice(0, markerAt) + bomless.slice(markerAt + 1); // drop the leading *
    }
    return bomless;
  });
}

/** Enabled for the New Plugin gesture, disabled for the reconcile. Throws if the
 *  name is already present. */
export function appendPluginInText(text: string, pluginName: string, enabled = true): string {
  return withBomPreserved(text, (bomless) => {
    for (const { start, contentEnd } of lineRanges(bomless)) {
      const content = bomless.slice(start, contentEnd);
      if (isEntryLine(content) && pluginNameOf(content) === pluginName) {
        throw new Error(`Plugin already in plugins.txt: ${pluginName}`);
      }
    }
    return appendEntryLine(bomless, pluginName, enabled);
  });
}

/** Throws if the name has no entry line. */
export function removePluginFromText(text: string, pluginName: string): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const idx = lines.findIndex((l) => isEntryLine(l) && pluginNameOf(l) === pluginName);
    if (idx === -1) throw new Error(`Plugin not found in plugins.txt: ${pluginName}`);
    lines.splice(idx, 1);
    return lines.join('');
  });
}

/** `toIndex` counts entries with the moved lines already removed, and clamps to
 *  the last slot. The block keeps its source order, whatever order the names came
 *  in; comment and blank lines keep their positions. */
export function movePluginsInText(text: string, pluginNames: string[], toIndex: number): string {
  return withBomPreserved(text, (bomless) => {
    const lines = splitLinesKeepEol(bomless);
    const wanted = new Set(pluginNames);

    // Collect the moved lines in *source* order (not argument order).
    const moveIdx = [...lines.keys()].filter(
      (i) => isEntryLine(lines[i]) && wanted.has(pluginNameOf(lines[i])),
    );
    const found = new Set(moveIdx.map((i) => pluginNameOf(lines[i])));
    const missing = pluginNames.find((n) => !found.has(n));
    if (missing !== undefined) throw new Error(`Plugin not found in plugins.txt: ${missing}`);

    const block = moveIdx.map((i) => lines[i]);
    for (const i of [...moveIdx].reverse()) lines.splice(i, 1); // remove high→low to keep indices valid

    const insertAt = insertIndexAmongEntries(lines, isEntryLine, toIndex);
    lines.splice(insertAt, 0, ...block);
    return lines.join('');
  });
}

/** A drag names a pre-removal target row, but `movePluginsInText` counts from the
 *  list with the moved names gone, so every moved row above the target shifts it
 *  left. An absent or unknown `targetName` appends. */
export function dropIndexForMove(
  order: string[],
  movedNames: string[],
  targetName: string | undefined,
): number {
  const moved = new Set(movedNames);
  const found = targetName === undefined ? -1 : order.indexOf(targetName);
  const targetIndex = found < 0 ? order.length : found;
  let movedBefore = 0;
  for (let i = 0; i < targetIndex; i++) if (moved.has(order[i])) movedBefore++;
  return targetIndex - movedBefore;
}
