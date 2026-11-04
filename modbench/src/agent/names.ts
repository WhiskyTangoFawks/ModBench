import { z } from 'zod';
import { foldPath, modOrigin, OVERWRITE_LABEL, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import { sameEntry, type FileOrigin, type OriginFolder } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instanceLoader/instance';
import { exactPluginAddressKey, pluginNameKey, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { filesOfOrigin } from '../drivingLib/copiesToRead';
import { present } from '../ports/present';
import { Refusal } from '../drivingLib/refusal';
import { originShown, type AgentValue } from './notRestored';

export interface ModName {
  name: string;
  kind?: 'mod' | 'separator';
}

/** A mod, a separator or Overwrite, as list_mods names it. */
export const CONTAINER_NAME = z
  .strictObject({ name: z.string().optional(), kind: z.enum(['mod', 'separator', 'runtimeOutput']).optional() })
  .refine(({ name, kind }) => name !== undefined || kind === 'runtimeOutput', { message: 'A mod or separator needs a name.', path: ['name'] })
  .transform(({ name, kind }): ContainerName => ({ name: name ?? OVERWRITE_LABEL, ...(kind === undefined ? {} : { kind }) }));

export interface ContainerName {
  name: string;
  kind?: 'mod' | 'separator' | 'runtimeOutput';
}

export interface PluginName {
  name: string;
  origin?: string;
}

export interface FileName {
  mod: ContainerName;
  path: string;
}

type Entry = InstanceValue['mods'][number];

export type Container = Entry | { kind: 'runtimeOutput'; name: typeof OVERWRITE_LABEL };

const OVERWRITE: Container = { kind: 'runtimeOutput', name: OVERWRITE_LABEL };

const asNamed = ({ kind, name }: Container): string => `${kind} ${name}`;

type EntryKeys = Pick<InstanceValue, 'mods' | 'entryKey'>;
type PluginKeys = EntryKeys & Pick<AgentValue, 'plugins' | 'pluginsLoadedWithNoLine' | 'notRestored'>;

function matchesOf(value: EntryKeys, { name, kind }: ModName): readonly Entry[] {
  return value.mods.filter((entry) => sameEntry(value, entry, { kind: kind ?? entry.kind, name }));
}

function refusalFor(given: ContainerName, matches: readonly Container[]): string | undefined {
  if (matches.length === 1) return undefined;
  if (matches.length === 0) return `Nothing is named "${given.name}"${given.kind === undefined ? '' : ` as a ${given.kind}`}.`;
  return `"${given.name}" means more than one thing: ${matches.map(asNamed).join('; ')}. Name it with its kind.`;
}

function namedBy<Given extends ContainerName, Found extends Container>(given: readonly Given[], matchesFor: (one: Given) => readonly Found[]): Found[] {
  const resolved = given.map((one) => ({ one, matches: matchesFor(one) }));
  const refusals = resolved.flatMap(({ one, matches }) => refusalFor(one, matches) ?? []);
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.flatMap(({ matches }) => matches);
}

export const modsNamed = (value: EntryKeys, given: readonly ModName[]): Entry[] => namedBy(given, (one) => matchesOf(value, one));

/** Each mod, separator or Overwrite named as list_mods names it; a name with no kind that a mod and Overwrite share is refused. */
export const containersNamed = (value: EntryKeys, given: readonly ContainerName[]): Container[] =>
  namedBy(given, ({ name, kind }): readonly Container[] => {
    if (kind === 'runtimeOutput') return [OVERWRITE];
    const entries = matchesOf(value, { name, kind });
    return kind === undefined && name === OVERWRITE_LABEL ? [...entries, OVERWRITE] : entries;
  });

/** Each file name as the Downloads view shows it. */
export function downloadedFilesNamed(downloadedFiles: InstanceValue['downloadedFiles'], given: readonly string[]): string[] {
  if (downloadedFiles.kind === 'unresolved') throw new Refusal(downloadedFiles.reason);
  const held = new Set(downloadedFiles.rows.map(({ name }) => name));
  const missing = given.filter((name) => !held.has(name));
  if (missing.length > 0) throw new Refusal(missing.map((name) => `Nothing is named "${name}" among the downloaded files.`).join(' '));
  return [...given];
}

interface NamedPath {
  readonly ownPath: string;
  readonly relativePath: string;
}

export interface FileNamed {
  origin: FileOrigin;
  file: string;
  relativePath: string;
}

const ownPathOf = ({ includedPath, relativePath }: OriginFolder): NamedPath => ({ ownPath: includedPath, relativePath });

function pathMatches(own: readonly NamedPath[], path: string): NamedPath[] {
  const folded = own.filter(({ ownPath }) => foldPath(ownPath) === foldPath(path));
  const exact = folded.filter(({ ownPath }) => ownPath === path);
  return exact.length > 0 ? exact : folded;
}

function fileIn(mod: Container, given: FileName, own: readonly NamedPath[]): FileNamed | string {
  const { name } = mod;
  if (mod.kind === 'separator') return `"${name}" is a separator; it has no files.`;
  const matches = pathMatches(own, given.path);
  const [only, second] = matches;
  if (only === undefined) return `Nothing is named "${given.path}" in mod ${name}.`;
  if (second !== undefined) return `"${given.path}" means more than one thing in mod ${name}: ${matches.map(({ relativePath }) => relativePath).join('; ')}.`;
  return { origin: originOf(mod), file: only.ownPath, relativePath: only.relativePath };
}

function pathsIn(
  value: InstanceValue, given: readonly FileName[], heldBy: (origin: FileOrigin) => readonly NamedPath[],
): FileNamed[] {
  const containers = containersNamed(value, given.map(({ mod }) => mod));
  const resolved = given.map((one, at) => {
    const container = present(containers[at], 'a container for each name');
    return fileIn(container, one, heldBy(originOf(container)));
  });
  const refusals = resolved.filter((one) => typeof one === 'string');
  if (refusals.length > 0) throw new Refusal(refusals.join(' '));
  return resolved.filter((one) => typeof one !== 'string');
}

export const originOf = (container: Container): FileOrigin => (container.kind === 'runtimeOutput' ? RUNTIME_OUTPUT : modOrigin(container.name));

const foldersOf = (value: InstanceValue, origin: FileOrigin): readonly OriginFolder[] =>
  (origin.kind === 'mod' ? value.foldersByMod.get(origin.name) ?? [] : value.overwriteFolders);

/** Each file by its path in its mod, with the mod manager's mark left out, in the mod's own casing. */
export const filesNamed = (value: InstanceValue, given: readonly FileName[]): FileNamed[] =>
  pathsIn(value, given, (origin) => filesOfOrigin(value, origin).map(ownPathOf));

/** Each file or folder by its path in its mod, as `filesNamed` answers a file. */
export const filesAndFoldersNamed = (value: InstanceValue, given: readonly FileName[]): FileNamed[] =>
  pathsIn(value, given, (origin) => [...filesOfOrigin(value, origin), ...foldersOf(value, origin)].map(ownPathOf));

const FILE_ORIGIN = z.union([
  z.object({ kind: z.literal('mod'), name: z.string() }),
  z.object({ kind: z.literal('runtimeOutput') }),
]) satisfies z.ZodType<FileOrigin>;

const FILE_REF = z.looseObject({ origin: FILE_ORIGIN, relativePath: z.string() });

/** A file or folder an answer names by the path the mod holds it at, named by its own path. */
export function namedByOwnPath(value: InstanceValue, item: unknown): unknown {
  const parsed = FILE_REF.safeParse(item);
  if (!parsed.success) return item;
  const { origin, relativePath } = parsed.data;
  const held = [...filesOfOrigin(value, origin), ...foldersOf(value, origin)].find((one) => one.relativePath === relativePath);
  return held === undefined ? item : { ...parsed.data, relativePath: held.includedPath };
}

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
    matches: [...new Map(
      [...value.plugins, ...value.pluginsLoadedWithNoLine ?? []]
        .filter((plugin) => pluginNameKey(plugin.name) === pluginNameKey(one.name) && (one.origin === undefined || originShown(value, plugin) === originOf(one.origin)))
        .map(({ name, origin }): [string, PluginAddress] => [exactPluginAddressKey({ name, origin }), { name, origin }]),
    ).values()],
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
