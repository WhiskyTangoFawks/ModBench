// A Papyrus script renamed from the Explorer: each record that attaches it follows (ADR-0028), when the renamed file is
// the copy the game takes the script from.

import { basename } from 'node:path';
import { change, type RenameEditing } from '../coreLib/change';
import type { MEditClient } from '../client';
import type { InstanceAdapter, RenamedSymbol } from '../instanceAdapter/instanceAdapter';
import type { ChangeResult } from '../ports/changeResult';
import { errorMessage } from '../ports/errorMessage';
import { originsWinningFirst, sameName, type EntryOwner, type ScriptSymbol } from '../symbolNames/symbolNames';
import { papyrusScriptFiles } from '../tables/gamePaths';
import { failureReason, isReadFailed } from '../wire/readFailed';

type ScriptRenamed = Extract<RenamedSymbol, { kind: 'script' }>;
type Source = Parameters<InstanceAdapter['originHoldsFile']>[0];

interface ScriptRenameAccess {
  readonly adapter: Pick<InstanceAdapter, 'gameRelease' | 'modOrder' | 'originHoldsFile'>;
  readonly client: Pick<MEditClient, 'getScriptReferences'>;
  /** The box whose files name a script: plugin source. */
  readonly references: EntryOwner<ScriptSymbol>;
}

type Refused = { readonly applied: false; readonly refusal: string; readonly detail?: string };

interface Copy {
  readonly source: Source;
  readonly path: string;
}

const sameSource = (a: Source, b: Source): boolean => a.kind === b.kind && (a.kind !== 'mod' || (b.kind === 'mod' && sameName(a.name, b.name)));

const labelOf = (source: Source): string => {
  if (source.kind === 'dataFolder') return 'the Data folder';
  return source.kind === 'mod' ? source.name : 'Overwrite';
};

const placeOf = ({ source, path }: Copy): string => `${labelOf(source)}'s ${path}`;

// Each copy of the script's compiled script and of its sources an enabled mod, Overwrite or the Data folder holds.
async function copiesOf(access: ScriptRenameAccess, name: string): Promise<{ compiled: Copy[]; sources: Copy[] }> {
  const files = papyrusScriptFiles(await access.adapter.gameRelease(), name);
  const sources: Source[] = [...originsWinningFirst((await access.adapter.modOrder()).mods), { kind: 'dataFolder' }];
  const holding = async (path: string): Promise<Copy[]> => {
    const held = await Promise.all(sources.map(async (source) => (await access.adapter.originHoldsFile(source, path) ? [{ source, path }] : [])));
    return held.flat();
  };
  const [compiled, ...bySource] = await Promise.all([files?.compiled, ...files?.sources ?? []].flatMap((path) => (path === undefined ? [] : [holding(path)])));
  return { compiled: compiled ?? [], sources: bySource.flat() };
}

async function leftBehind(access: ScriptRenameAccess, name: string): Promise<string> {
  const answer = await access.client.getScriptReferences(name);
  if (isReadFailed(answer)) return `the plugins mEdit reads: ${failureReason(answer)}`;
  return [...answer.copies.map(({ formKey, plugin }) => `${formKey} in ${plugin.name} (${plugin.origin})`), ...answer.unread].join('\n');
}

// The game takes a script from its compiled script, and a script with none yet is its source. Its records follow only
// once no copy the game finds keeps the name: renaming a source leaves any compiled copy.
async function refusalOf(access: ScriptRenameAccess, { origin, path, name, to }: ScriptRenamed): Promise<Refused | undefined> {
  const isRenamed = (copy: Copy): boolean => sameSource(copy.source, origin) && sameName(copy.path, path);
  const held = await copiesOf(access, name);
  if (![...held.compiled, ...held.sources].some(isRenamed)) {
    return { applied: false, refusal: `the game takes no "${name}" from ${labelOf(origin)}, which is not enabled.` };
  }
  const others = (copies: readonly Copy[]): Copy[] => copies.filter((copy) => !isRenamed(copy));
  const [kept] = held.compiled.some(isRenamed) ? others(held.compiled) : [...held.compiled, ...others(held.sources)];
  if (kept !== undefined) return { applied: false, refusal: `the game still finds "${name}" at ${placeOf(kept)}.` };
  if (to.name === undefined) return { applied: false, refusal: `"${basename(to.path)}" names no Papyrus script.`, detail: await leftBehind(access, name) };
  if (sameName(name, to.name)) return undefined;
  const newCopies = await copiesOf(access, to.name);
  const other = [...newCopies.compiled, ...newCopies.sources].find((copy) => !(sameSource(copy.source, origin) && sameName(copy.path, to.path)));
  return other === undefined ? undefined : { applied: false, refusal: `"${to.name}" already names the Papyrus script at ${placeOf(other)}.` };
}

async function renameScript(access: ScriptRenameAccess, { held, apply }: RenameEditing, renamed: ScriptRenamed): Promise<ChangeResult | Refused> {
  const { name, to } = renamed;
  try {
    const refused = await refusalOf(access, renamed);
    if (refused !== undefined || to.name === undefined) return refused ?? { applied: false, refusal: `"${basename(to.path)}" names no Papyrus script.` };
  } catch (err) {
    return { applied: false, refusal: `Could not check "${name}" against the scripts the game takes.`, detail: errorMessage(err) };
  }
  const newName = to.name;
  return change({ definition: access.references, references: [] }, (owner) => owner.plan({ kind: 'script', name }, newName, held), apply);
}

export type ScriptRenameCommands = ReturnType<typeof scriptRenameCommands>;

export function scriptRenameCommands(access: ScriptRenameAccess) {
  return {
    renameScript: (editing: RenameEditing, renamed: ScriptRenamed) => renameScript(access, editing, renamed),
  };
}
