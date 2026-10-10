// The game's plugins.txt: a leading `*` marks enabled, `#` lines and blanks carry no
// meaning, and the bottom of the file is winning-most. Mutations edit the lines, so
// comment and blank lines survive untouched.

import { editLines, entryLineIndices, stripBom } from './lineScan';

/** The plugin order, one line per plugin file. */
export const PLUGINS_FILE_NAME = 'plugins.txt';

/** A plugin's filename as ADR-0012 compares it. */
export const pluginKey = (name: string): string => name.toLowerCase();

/** A single plugins.txt line (a plugin file), in plugin order. The `*` prefix, the enabled
 *  marker, is modelled as `enabled`; the marker itself is never surfaced in `name`. Distinct
 *  from a Mod: plugins.txt has no separators. */
export interface PluginEntry {
  name: string;
  enabled: boolean;
}

// A hand-edited plugins.txt can pad a line, so reads trim.
const isEntryLine = (line: string): boolean => {
  const c = line.trim();
  return c.length > 0 && !c.startsWith('#');
};

const isEnabledEntry = (line: string): boolean => line.trim().startsWith('*');

// `PluginEntry.name` is a matching key, so a hand-padded line must resolve to the
// same name as a clean one — neither the padding nor the `*` may leak into it.
const pluginNameOf = (line: string): string => {
  const c = line.trim();
  return c.startsWith('*') ? c.slice(1) : c;
};

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

const entryLineAt = (lines: readonly string[], pluginName: string): number =>
  lines.findIndex((l) => isEntryLine(l) && pluginNameOf(l) === pluginName);

const notFound = (pluginName: string): Error => new Error(`Plugin not found in plugins.txt: ${pluginName}`);

const paddingOf = (line: string): number => line.length - line.trimStart().length;

/** A name with no entry line has no marker to toggle, and leaves the text
 *  untouched rather than throwing. */
export function setPluginEnabledInText(text: string, pluginName: string, enabled: boolean): string {
  return editLines(text, (lines) => {
    const idx = entryLineAt(lines, pluginName);
    const line = lines[idx];
    if (line === undefined || isEnabledEntry(line) === enabled) return lines;
    const markerAt = paddingOf(line);
    lines[idx] = line.slice(0, markerAt) + (enabled ? '*' + line.slice(markerAt) : line.slice(markerAt + 1));
    return lines;
  });
}

/** Disabled, as plugin sync adds a plugin it found on disk, at the winning end but before any
 *  trailing comment or blank lines. Throws if the name is already present. */
export function appendPluginInText(text: string, pluginName: string): string {
  return editLines(text, (lines) => {
    if (entryLineAt(lines, pluginName) !== -1) throw new Error(`Plugin already in plugins.txt: ${pluginName}`);
    const lastEntry = entryLineIndices(lines, isEntryLine).at(-1);
    lines.splice(lastEntry === undefined ? lines.length : lastEntry + 1, 0, pluginName);
    return lines;
  });
}

/** Throws if the name has no entry line. */
export function removePluginFromText(text: string, pluginName: string): string {
  return editLines(text, (lines) => {
    const idx = entryLineAt(lines, pluginName);
    if (idx === -1) throw notFound(pluginName);
    lines.splice(idx, 1);
    return lines;
  });
}

/** The line keeps its place, its enabled mark and its padding. Throws if the name has no entry line. */
export function renamePluginInText(text: string, pluginName: string, newName: string): string {
  return editLines(text, (lines) => {
    const idx = entryLineAt(lines, pluginName);
    const line = lines[idx];
    if (line === undefined) throw notFound(pluginName);
    const nameAt = line.indexOf(pluginName, paddingOf(line));
    lines[idx] = line.slice(0, nameAt) + newName + line.slice(nameAt + pluginName.length);
    return lines;
  });
}

/** `toIndex` counts entries with the moved lines already removed, and clamps to
 *  the last slot. The block keeps its source order, whatever order the names came
 *  in; comment and blank lines keep their positions. */
export function movePluginsInText(text: string, pluginNames: string[], toIndex: number): string {
  return editLines(text, (lines) => {
    const wanted = new Set(pluginNames);
    const isMoved = (line: string): boolean => isEntryLine(line) && wanted.has(pluginNameOf(line));
    const found = new Set(lines.filter(isMoved).map(pluginNameOf));
    const missing = pluginNames.find((n) => !found.has(n));
    if (missing !== undefined) throw notFound(missing);

    const block = lines.filter(isMoved);
    const rest = lines.filter((line) => !isMoved(line));
    const entries = entryLineIndices(rest, isEntryLine);
    const atEntry = entries[Math.min(Math.max(0, toIndex), entries.length)];
    const lastEntry = entries.at(-1);
    rest.splice(atEntry ?? (lastEntry === undefined ? rest.length : lastEntry + 1), 0, ...block);
    return rest;
  });
}
