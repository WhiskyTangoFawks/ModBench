// Pure, byte-faithful text transforms over an MO2 profile's plugins.txt.
//
// plugins.txt lines (top = loads first, bottom wins record overrides):
//   # comment              (preserved verbatim, not surfaced)
//   *Some Plugin.esp       (enabled plugin — leading * marker)
//   Some Plugin.esp        (disabled plugin — no marker)
//                          (blank line, preserved verbatim, not surfaced)
//
// Simpler than modlist.txt: no separator concept. All mutations splice the raw
// string in place, so CRLF/LF, trailing newline, BOM, and every unmodelled line
// (comment/blank) survive untouched.

import type { PluginEntry } from '../model';
import { detectEol, insertIndexAmongEntries, lineContent, lineRanges, splitLinesKeepEol, stripBom, withBomPreserved } from './lineScan';

/** The part of a line #635's fixes key off: EOL-stripped, then leading/trailing
 *  whitespace stripped too — MO2 itself never writes padded lines, but a
 *  hand-edited plugins.txt (never assume exclusive ownership of the file) can,
 *  and the deleted `readPluginLines` this module's `isEntryLine`/`pluginNameOf`
 *  replaced always `.trim()`ed the whole line before reading `*`/the name off
 *  it. Only used for *reading* — `setPluginEnabledInText`'s write still has to
 *  locate the marker's real byte offset, which this collapses away, so it
 *  computes that separately (see its own comment). */
const trimmedEntryContent = (line: string): string => lineContent(line).trim();

/** An entry line is any non-blank, non-comment line (after trimming — a
 *  whitespace-only line, or a `#` comment with incidental leading whitespace,
 *  both count as blank/comment, not an entry). Comment and blank lines carry
 *  no model meaning. */
const isEntryLine = (line: string): boolean => {
  const c = trimmedEntryContent(line);
  return c.length > 0 && !c.startsWith('#');
};

/** Whether an entry line's `*` (enabled) marker is present — after trimming, so
 *  incidental leading whitespace before the marker doesn't hide it. */
const isEnabledEntry = (line: string): boolean => trimmedEntryContent(line).startsWith('*');

/** Plugin name for an entry line, with the leading `*` (enabled) marker and any
 *  incidental leading/trailing whitespace removed — `PluginEntry.name` is a
 *  matching key (`setPluginEnabledInText`, `appendPluginInText`'s duplicate
 *  check, `movePluginsInText`), so it must report the same name a hand-padded
 *  line's *real* plugin resolves to, not a name containing the padding or a
 *  literal `*`. */
const pluginNameOf = (line: string): string => {
  const c = trimmedEntryContent(line);
  return c.startsWith('*') ? c.slice(1) : c;
};

/** Parse plugins.txt into the ordered model view (top = loads first). Only
 *  entry lines are surfaced; comment/blank lines are ignored (preserved on write). */
export function parsePlugins(text: string): PluginEntry[] {
  const entries: PluginEntry[] = [];
  for (const raw of stripBom(text).split(/\r\n|\r|\n/)) {
    if (!isEntryLine(raw)) continue;
    entries.push({ name: pluginNameOf(raw), enabled: isEnabledEntry(raw) });
  }
  return entries;
}

/** Set a plugin's enabled state by adding/removing its leading `*` marker.
 *  Throws if the plugin is absent. */
export function setPluginEnabledInText(text: string, pluginName: string, enabled: boolean): string {
  return withBomPreserved(text, (bomless) => {
    for (const { start, contentEnd } of lineRanges(bomless)) {
      const content = bomless.slice(start, contentEnd);
      if (!isEntryLine(content) || pluginNameOf(content) !== pluginName) continue;
      const isEnabled = isEnabledEntry(content);
      if (isEnabled === enabled) return bomless; // already in the requested state
      // The marker sits at the first non-whitespace character of the line, which is
      // `start` for a real MO2-written line but not necessarily for a hand-edited one
      // with incidental leading whitespace — matching pluginNameOf/isEnabledEntry's own
      // trim-then-read means this write must locate the marker the same trim-aware way,
      // or it would splice into the padding instead of flipping the real marker.
      const markerAt = start + (content.length - content.trimStart().length);
      if (enabled) return bomless.slice(0, markerAt) + '*' + bomless.slice(markerAt);
      return bomless.slice(0, markerAt) + bomless.slice(markerAt + 1); // drop the leading *
    }
    throw new Error(`Plugin not found in plugins.txt: ${pluginName}`);
  });
}

/** The New Plugin gesture's own write — appends a new, always-enabled entry line at the
 *  winning end (bottom: "bottom wins record overrides", this file's own header comment), landing
 *  before any trailing comment/blank lines rather than after them, the same "before the tail"
 *  placement `movePluginsInText`'s own end-of-file case uses. Byte-faithful: every existing byte
 *  survives untouched, and the new line's EOL matches whatever the file already uses. Throws if
 *  the name is already present — never a silent duplicate line. */
export function appendPluginInText(text: string, pluginName: string): string {
  return withBomPreserved(text, (bomless) => {
    for (const { start, contentEnd } of lineRanges(bomless)) {
      const content = bomless.slice(start, contentEnd);
      if (isEntryLine(content) && pluginNameOf(content) === pluginName) {
        throw new Error(`Plugin already in plugins.txt: ${pluginName}`);
      }
    }

    const eol = detectEol(bomless);
    if (bomless.length === 0) return `*${pluginName}${eol}`;

    const lines = splitLinesKeepEol(bomless);
    const last = lines[lines.length - 1];
    if (!/\r\n$|\r$|\n$/.test(last)) lines[lines.length - 1] = last + eol;

    const entryLineIdx = [...lines.keys()].filter((i) => isEntryLine(lines[i]));
    const insertAt = entryLineIdx.length === 0 ? lines.length : entryLineIdx.at(-1)! + 1;
    lines.splice(insertAt, 0, `*${pluginName}${eol}`);
    return lines.join('');
  });
}

/** Move one or more plugins (by name) so the moved block occupies entry-index
 *  `toIndex` among plugins.txt's entry lines (top = loads first), counting the
 *  entries with the moved lines removed. The moved lines keep their original
 *  relative order regardless of selection contiguity or the order names are
 *  passed in. Non-entry lines (comment/blank) keep their position. Out-of-range
 *  `toIndex` clamps to the last slot. Throws if any name is absent. */
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

/** Convert a UI drop onto a row into the `toIndex` `movePluginsInText` expects.
 *  A drag hands us a *pre-removal* target ("insert the block before this row"),
 *  but `movePluginsInText` counts `toIndex` among the entries with the moved
 *  names already removed — so any moved row sitting above the target shifts it
 *  left. `targetName` is the row dropped onto, or `undefined` to drop past the
 *  last row (append). An unknown target name also appends (defensive). */
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
