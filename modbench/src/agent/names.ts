import { foldPath } from '../instanceLoader/fileConflictIndex';
import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import type { OriginFile } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instanceLoader/instance';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { Refusal } from '../drivingLib/refusal';

export interface ModName {
  name: string;
  kind?: 'mod' | 'separator';
}

export interface PluginName {
  name: string;
  origin?: string;
}

export interface FileName {
  mod: ModName;
  path: string;
}

type Entry = InstanceValue['mods'][number];

const asNamed = ({ kind, name }: Entry): string => `${kind} ${name}`;

type EntryKeys = Pick<InstanceValue, 'mods' | 'entryKey'>;

function matchesOf({ mods, entryKey }: EntryKeys, { name, kind }: ModName): readonly Entry[] {
  return mods.filter((entry) => (kind === undefined || entry.kind === kind) && entryKey(entry) === entryKey({ kind: entry.kind, name }));
}

function refusalFor(given: ModName, matches: readonly Entry[]): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `Nothing is named "${given.name}"${given.kind === undefined ? '' : ` as a ${given.kind}`}.`;
  return `"${given.name}" means more than one thing: ${matches.map(asNamed).join('; ')}. Name it with its kind.`;
}

export function modsNamed(value: EntryKeys, given: readonly ModName[]): Entry[] {
  const resolved = given.map((one) => ({ one, matches: matchesOf(value, one) }));
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

function fileIn(mod: Entry | undefined, given: FileName, own: readonly OriginFile[]): { mod: string; file: string } | string {
  const name = mod?.name ?? given.mod.name;
  if (mod?.kind !== 'mod') return `"${name}" is a separator; it has no files.`;
  const matches = pathMatches(own, given.path);
  if (matches.length === 0) return `Nothing is named "${given.path}" in mod ${name}.`;
  if (matches.length > 1) return `"${given.path}" means more than one thing in mod ${name}: ${matches.join('; ')}.`;
  return { mod: name, file: matches.join() };
}

/** Each file by its path in its mod, answered in the mod's own casing. */
export function filesNamed(value: InstanceValue, given: readonly FileName[]): { mod: string; file: string }[] {
  const mods = modsNamed(value, given.map(({ mod }) => mod));
  const resolved = given.map((one, at) => fileIn(mods[at], one, value.filesByMod.get(mods[at]?.name ?? '') ?? []));
  const refusals = resolved.filter((one) => typeof one === 'string');
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.filter((one) => typeof one !== 'string');
}

const asPlugin = ({ name, origin }: PluginAddress): string => `${name} in ${origin}`;

function pluginRefusal({ name, origin }: PluginName, matches: readonly PluginAddress[]): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `No plugin is named "${name}"${origin === undefined ? '' : ` in ${origin}`}.`;
  return `"${name}" means more than one plugin: ${matches.map(asPlugin).join('; ')}. Name it with its origin.`;
}

/** Each plugin as the load order holds it. */
export function pluginsNamed(plugins: InstanceValue['plugins'], given: readonly PluginName[]): PluginAddress[] {
  const resolved = given.map((one) => ({
    one,
    matches: plugins.filter(({ name, origin }) => pluginKey(name) === pluginKey(one.name)
      && (one.origin === undefined || origin.toLowerCase() === one.origin.toLowerCase())).map(({ name, origin }) => ({ name, origin })),
  }));
  const refusals = resolved.flatMap(({ one, matches }) => pluginRefusal(one, matches) ?? []);
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.flatMap(({ matches }) => matches);
}

/** Each plugin whose line in plugins.txt the gesture changes: the copy that line governs, as the Plugins view's rows are. */
export function linesNamed(plugins: InstanceValue['plugins'], given: readonly PluginName[]): PluginAddress[] {
  const named = pluginsNamed(plugins, given);
  const refusals = named.flatMap((address) => {
    const governing = plugins.find(({ name, winning }) => winning && pluginKey(name) === pluginKey(address.name));
    return governing === undefined || samePluginAddress(governing, address)
      ? []
      : `${asPlugin(address)} is overridden, and the line for "${address.name}" is ${asPlugin(governing)}'s. Name that one.`;
  });
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return named;
}
