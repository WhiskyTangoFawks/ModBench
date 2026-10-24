import { foldPath } from '../instanceLoader/fileConflictIndex';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import { sameEntry, type OriginFolder } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instanceLoader/instance';
import { pluginNameKey, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { Refusal } from '../drivingLib/refusal';
import { originShown, type AgentValue } from './notRestored';

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
type PluginKeys = EntryKeys & Pick<AgentValue, 'plugins' | 'notRestored'>;

function matchesOf(value: EntryKeys, { name, kind }: ModName): readonly Entry[] {
  return value.mods.filter((entry) => sameEntry(value, entry, { kind: kind ?? entry.kind, name }));
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
export function downloadedFilesNamed(downloadedFiles: InstanceValue['downloadedFiles'], given: readonly string[]): string[] {
  if (downloadedFiles.kind === 'unresolved') throw new Refusal(downloadedFiles.reason);
  const held = new Set(downloadedFiles.rows.map(({ name }) => name));
  const missing = given.filter((name) => !held.has(name));
  if (missing.length > 0) throw new Refusal(missing.map((name) => `Nothing is named "${name}" among the downloaded files.`).join(' '));
  return [...given];
}

function pathMatches(own: readonly OriginFolder[], path: string): string[] {
  const folded = own.filter(({ relativePath }) => foldPath(relativePath) === foldPath(path)).map(({ relativePath }) => relativePath);
  return folded.includes(path) ? [path] : folded;
}

function fileIn(mod: Entry | undefined, given: FileName, own: readonly OriginFolder[]): { mod: string; file: string } | string {
  const name = mod?.name ?? given.mod.name;
  if (mod?.kind !== 'mod') return `"${name}" is a separator; it has no files.`;
  const matches = pathMatches(own, given.path);
  if (matches.length === 0) return `Nothing is named "${given.path}" in mod ${name}.`;
  if (matches.length > 1) return `"${given.path}" means more than one thing in mod ${name}: ${matches.join('; ')}.`;
  return { mod: name, file: matches.join() };
}

function pathsIn(
  value: InstanceValue, given: readonly FileName[], heldBy: (mod: string) => readonly OriginFolder[],
): { mod: string; file: string }[] {
  const mods = modsNamed(value, given.map(({ mod }) => mod));
  const resolved = given.map((one, at) => fileIn(mods[at], one, heldBy(mods[at]?.name ?? '')));
  const refusals = resolved.filter((one) => typeof one === 'string');
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.filter((one) => typeof one !== 'string');
}

/** Each file by its path in its mod, answered in the mod's own casing. */
export const filesNamed = (value: InstanceValue, given: readonly FileName[]): { mod: string; file: string }[] =>
  pathsIn(value, given, (mod) => value.filesByMod.get(mod) ?? []);

/** Each file or folder by its path in its mod, answered in the mod's own casing. */
export const filesAndFoldersNamed = (value: InstanceValue, given: readonly FileName[]): { mod: string; file: string }[] =>
  pathsIn(value, given, (mod) => [...value.filesByMod.get(mod) ?? [], ...value.foldersByMod.get(mod) ?? []]);

const asPlugin = ({ name, origin }: PluginAddress): string => `${name} in ${origin}`;

function pluginRefusal({ name, origin }: PluginName, matches: readonly PluginAddress[], notRead: string | undefined): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `No plugin is named "${name}"${origin === undefined ? '' : ` in ${origin}`}.${notRead === undefined ? '' : ` ${notRead}`}`;
  return `"${name}" means more than one plugin: ${matches.map(asPlugin).join('; ')}. Name it with its origin.`;
}

/** Each plugin as the load order holds it, named by the origin list_plugins shows. */
export function pluginsNamed(value: PluginKeys, given: readonly PluginName[]): PluginAddress[] {
  const originOf = (origin: string): string => modOfOrigin(value, origin)?.name ?? origin;
  const resolved = given.map((one) => ({
    one,
    matches: value.plugins.filter((plugin) => pluginNameKey(plugin.name) === pluginNameKey(one.name)
      && (one.origin === undefined || originShown(value, plugin) === originOf(one.origin))).map(({ name, origin }) => ({ name, origin })),
  }));
  const undecided = new Set(value.notRestored?.undecided.map(pluginNameKey));
  const notRead = (one: PluginName) => (one.origin !== undefined && undecided.has(pluginNameKey(one.name)) ? value.notRestored?.unread : undefined);
  const refusals = resolved.flatMap(({ one, matches }) => pluginRefusal(one, matches, notRead(one)) ?? []);
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.flatMap(({ matches }) => matches);
}

/** Each plugin whose line in plugins.txt the gesture changes: the copy that line governs, as the Plugins view's rows are. */
export function linesNamed(value: PluginKeys, given: readonly PluginName[]): PluginAddress[] {
  const named = pluginsNamed(value, given);
  const refusals = named.flatMap((address) => {
    const governing = value.plugins.find(({ name, winning }) => winning && pluginNameKey(name) === pluginNameKey(address.name));
    return governing === undefined || samePluginAddress(governing, address)
      ? []
      : `${asPlugin(address)} is overridden, and the line for "${address.name}" is ${asPlugin(governing)}'s. Name that one.`;
  });
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return named;
}
