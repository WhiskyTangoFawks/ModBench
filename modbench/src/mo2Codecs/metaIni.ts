// meta.ini is QSettings::IniFormat. `[installedFiles]` is a QSettings array whose key
// order is not guaranteed, so it's read scoped to the section and keyed by index.

import { detectEol, lineRanges } from './lineScan';

/** A mod folder's metadata file. */
export const MOD_META_FILE_NAME = 'meta.ini';

/** One meta.ini `[installedFiles]` entry — a Nexus mod/file id pair MO2 recorded as
 *  installed. Field names match the array's own (lowercase) keys. */
export interface InstalledFileId {
  modid: string;
  fileid: string;
}

export interface ModMeta {
  version?: string;
  nexusId?: string;
  archiveFilename?: string;
  installedFiles?: InstalledFileId[];
}

/** The keys Modbench owns in meta.ini: written fresh by `writeMetaIni`, or set into
 *  existing text by `setOwnedKeysInText`. */
export interface OwnedMetaKeys {
  gameName?: string;
  modid?: string;
  version?: string;
  installationFile?: string;
  installedFiles?: readonly InstalledFileId[];
}

const OWNED_GENERAL_KEYS = ['gameName', 'modid', 'version', 'installationFile'] as const;

// A `[installedFiles]` array line is `<index>\modid=` or `<index>\fileid=`; anything else
// in the section (its own `size=` key, malformed input) is not one.
function arrayEntryKey(line: string): { index: number; field: 'modid' | 'fileid'; value: string } | undefined {
  const eq = line.indexOf('=');
  if (eq === -1) return undefined;
  const key = line.slice(0, eq).trim();
  const sep = key.indexOf('\\');
  if (sep === -1) return undefined;
  const index = Number(key.slice(0, sep).trim());
  if (!Number.isInteger(index)) return undefined;
  const field = key.slice(sep + 1).trim().toLowerCase();
  if (field !== 'modid' && field !== 'fileid') return undefined;
  return { index, field, value: line.slice(eq + 1).trim() };
}

function parseInstalledFiles(text: string): InstalledFileId[] | undefined {
  const pairs = new Map<number, { modid?: string; fileid?: string }>();
  let inSection = false;
  for (const { start, contentEnd } of lineRanges(text)) {
    const line = text.slice(start, contentEnd).trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inSection = line.slice(1, -1).trim().toLowerCase() === 'installedfiles';
      continue;
    }
    if (!inSection) continue;
    const entry = arrayEntryKey(line);
    if (!entry) continue;
    const pair = pairs.get(entry.index) ?? {};
    pair[entry.field] = entry.value;
    pairs.set(entry.index, pair);
  }
  if (pairs.size === 0) return undefined;
  return [...pairs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { modid, fileid }]) => ({ modid: modid ?? '', fileid: fileid ?? '' }));
}

export function parseMetaIni(text: string): ModMeta {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const value = raw.slice(eq + 1).trim();
    if (value) values.set(raw.slice(0, eq).trim(), value); // blank == absent
  }
  const modid = values.get('modid');
  return {
    version: values.get('version'),
    nexusId: modid && modid !== '0' ? modid : undefined,
    archiveFilename: values.get('installationFile'),
    installedFiles: parseInstalledFiles(text),
  };
}

function renderGeneralSection(meta: OwnedMetaKeys, eol = '\n'): string {
  const lines = ['[General]'];
  for (const key of OWNED_GENERAL_KEYS) {
    const value = meta[key];
    if (value) lines.push(`${key}=${value}`);
  }
  return lines.join(eol) + eol;
}

function renderInstalledFilesSection(pairs: readonly InstalledFileId[] | undefined, eol = '\n'): string {
  if (!pairs || pairs.length === 0) return '';
  const lines = ['[installedFiles]'];
  pairs.forEach((pair, i) => {
    lines.push(`${i + 1}\\modid=${pair.modid}`);
    lines.push(`${i + 1}\\fileid=${pair.fileid}`);
  });
  lines.push(`size=${pairs.length}`);
  return lines.join(eol) + eol;
}

/** Keys use MO2's own names, so the result round-trips through `parseMetaIni`. */
export function writeMetaIni(meta: OwnedMetaKeys): string {
  return renderGeneralSection(meta) + renderInstalledFilesSection(meta.installedFiles);
}

// Finds, deletes or inserts one `key=value` line in an isolated section body. A new line
// always lands at the body's own start, so multiple keys fold in reverse of read order.
function setKeyInBody(body: string, key: string, value: string | undefined, eol: string): string {
  for (const { start, contentEnd, end } of lineRanges(body)) {
    const line = body.slice(start, contentEnd);
    const eq = line.indexOf('=');
    if (eq !== -1 && line.slice(0, eq).trim() === key) {
      if (value === undefined) return body.slice(0, start) + body.slice(end); // owned and cleared: delete
      return body.slice(0, start) + `${key}=${value}` + body.slice(contentEnd);
    }
  }
  if (value === undefined) return body; // owned, absent, still absent: no-op
  return `${key}=${value}${eol}` + body;
}

function applyGeneralEdits(body: string, meta: OwnedMetaKeys, eol: string): string {
  let next = body;
  for (const key of [...OWNED_GENERAL_KEYS].reverse()) next = setKeyInBody(next, key, meta[key], eol);
  return next;
}

interface SectionSpan {
  name: string;
  headerStart: number;
  /** Just past the header line's own EOL — the section's content starts here. */
  bodyStart: number;
  /** The next section header's start, or end of text. */
  bodyEnd: number;
}

function scanSections(text: string): SectionSpan[] {
  const sections: SectionSpan[] = [];
  for (const { start, contentEnd, end } of lineRanges(text)) {
    const trimmed = text.slice(start, contentEnd).trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const prior = sections.at(-1);
      if (prior) prior.bodyEnd = start;
      sections.push({ name: trimmed.slice(1, -1), headerStart: start, bodyStart: end, bodyEnd: text.length });
    }
  }
  return sections;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

// Edits are computed against the original text's offsets and applied in one sweep, so two
// edits at the same offset never see each other's shift.
function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const edit of sorted) {
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

/** Sets the keys Modbench owns into existing meta.ini text — replaced, added or (value
 *  absent) cleared — leaving every other key and section byte for byte as found. Over
 *  empty text this is exactly `writeMetaIni`'s output. */
export function setOwnedKeysInText(text: string, keys: OwnedMetaKeys): string {
  const sections = scanSections(text);
  const general = sections.find((s) => s.name === 'General');
  const installed = sections.find((s) => s.name === 'installedFiles');
  const eol = detectEol(text);

  const edits: TextEdit[] = [];

  if (general) {
    const body = text.slice(general.bodyStart, general.bodyEnd);
    edits.push({
      start: general.headerStart,
      end: general.bodyEnd,
      text: text.slice(general.headerStart, general.bodyStart) + applyGeneralEdits(body, keys, eol),
    });
  } else {
    edits.push({ start: 0, end: 0, text: renderGeneralSection(keys, eol) });
  }

  const installedText = renderInstalledFilesSection(keys.installedFiles, eol);
  if (installed) {
    edits.push({ start: installed.headerStart, end: installed.bodyEnd, text: installedText });
  } else if (installedText) {
    edits.push({ start: text.length, end: text.length, text: installedText });
  }

  return applyEdits(text, edits);
}
