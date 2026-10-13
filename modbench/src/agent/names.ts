import { foldPath } from '../instanceLoader/fileConflictIndex';
import type { OriginFile } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from './refusal';

export interface ModName {
  name: string;
  kind?: 'mod' | 'separator';
}

export interface FileName {
  mod: ModName;
  path: string;
}

type Entry = InstanceValue['mods'][number];

const asNamed = ({ kind, name }: Entry): string => `${kind} ${name}`;

function matchesOf(entries: readonly Entry[], { name, kind }: ModName): readonly Entry[] {
  return entries.filter((entry) => entry.name === name && (kind === undefined || entry.kind === kind));
}

function refusalFor(given: ModName, matches: readonly Entry[]): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `Nothing is named "${given.name}"${given.kind === undefined ? '' : ` as a ${given.kind}`}.`;
  return `"${given.name}" means more than one thing: ${matches.map(asNamed).join('; ')}. Name it with its kind.`;
}

export function modsNamed(entries: readonly Entry[], given: readonly ModName[]): Entry[] {
  const resolved = given.map((one) => ({ one, matches: matchesOf(entries, one) }));
  const refusals = resolved.flatMap(({ one, matches }) => refusalFor(one, matches) ?? []);
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.flatMap(({ matches }) => matches);
}

/** Each file name as the Downloads view shows it. */
export function downloadsNamed(downloads: InstanceValue['downloads'], given: readonly string[]): string[] {
  if (downloads.kind === 'unresolved') throw new Refusal(downloads.reason);
  const held = new Set(downloads.rows.map(({ name }) => name));
  const missing = given.filter((name) => !held.has(name));
  if (missing.length > 0) throw new Refusal(missing.map((name) => `Nothing is named "${name}" among the downloaded files.`).join(' '));
  return [...given];
}

function pathMatches(own: readonly OriginFile[], path: string): string[] {
  const folded = own.filter(({ relativePath }) => foldPath(relativePath) === foldPath(path)).map(({ relativePath }) => relativePath);
  return folded.includes(path) ? [path] : folded;
}

function pathRefusal(given: FileName, matches: readonly string[]): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `Nothing is named "${given.path}" in mod ${given.mod.name}.`;
  return `"${given.path}" means more than one thing in mod ${given.mod.name}: ${matches.join('; ')}.`;
}

/** Each file by its path in its mod, answered in the mod's own casing. */
export function filesNamed(value: InstanceValue, given: readonly FileName[]): { mod: string; file: string }[] {
  const mods = modsNamed(value.mods, given.map(({ mod }) => mod));
  const resolved = given.map((one, at) => {
    const mod = mods[at];
    if (mod?.kind !== 'mod') throw new Refusal(`"${mod?.name ?? one.mod.name}" is a separator; it has no files.`);
    return { one, mod: mod.name, matches: pathMatches(value.filesByMod.get(mod.name) ?? [], one.path) };
  });
  const refusals = resolved.flatMap(({ one, matches }) => pathRefusal(one, matches) ?? []);
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.map(({ mod, matches }) => ({ mod, file: matches[0] ?? '' }));
}
