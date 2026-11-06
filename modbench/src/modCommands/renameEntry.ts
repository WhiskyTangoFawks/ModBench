// Rename mod and rename separator (rename-mod trace): every box whose files name the mod or separator carries the
// rename (ADR-0028). A mod's source folder moves through mEdit's Source adapter.

import { basename } from 'node:path';
import type { TailOf } from '../coreLib/boundCommand';
import { change, type RenameEditing, type SymbolOwners } from '../coreLib/change';
import type { ChangeResult } from '../ports/changeResult';
export type { RenameEditing } from '../coreLib/change';
import { refuse } from '../coreLib/refuse';
import { sameEntry, type EntryRef, type InstanceAdapter, type ModOrderChange } from '../instanceAdapter/instanceAdapter';
import { manifestEntryReferences, sourceModsOf } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import { COMMITTED, NO_FILE_CHANGES, sameName, type Committed, type EntryOwner } from '../symbolNames/symbolNames';
import { sourceFolderMove, type MEditClient } from '../client';
import { renameModNameRefusal, separatorNameRefusal } from './modCommands';
import { EMPTY_MOD_NAME } from './nameRefusals';

export type EntryRenameClient = Pick<MEditClient, 'getSourceFolderMoveChanges' | 'followSourceFolderMove'>;

interface EntryRenameAccess {
  readonly adapter: InstanceAdapter;
  readonly client: EntryRenameClient;
}

interface FolderMove {
  readonly from: string;
  readonly to: string;
}

const folderOf = async (adapter: InstanceAdapter, entry: EntryRef): Promise<string | undefined> =>
  (await adapter.modOrder()).modFolders?.find((folder) => sameEntry(adapter, folder, entry))?.path;

// A write after the definition's own, which a reference that cannot follow does not stop (ADR-0028).
async function followed(what: string, write: () => Promise<unknown>): Promise<string[]> {
  try {
    await write();
    return [];
  } catch (err) {
    return [`${what}: ${errorMessage(err)}`];
  }
}

const renamedLine = ({ kind, name }: EntryRef, to: string): ModOrderChange =>
  (kind === 'mod' ? { kind: 'renameMod', from: name, to } : { kind: 'renameSeparator', from: name, to });

// A separator's folder moves with the first line renamed, so a failure
// before it writes nothing.
async function linesRenamed(adapter: InstanceAdapter, entry: EntryRef, to: string, inProfiles: readonly string[]): Promise<Committed> {
  const cannotFollow: string[] = [];
  let folderMoved = entry.kind === 'mod';
  for (const profile of inProfiles) {
    try {
      const { landed } = await adapter.changeModOrder(profile, (order) => (order.some((listed) => sameEntry(adapter, listed, entry)) ? [renamedLine(entry, to)] : []));
      folderMoved ||= landed.length > 0;
    } catch (err) {
      if (!folderMoved) return { failed: errorMessage(err) };
      cannotFollow.push(`profile "${profile}"'s ${adapter.names.modOrderFile}: ${errorMessage(err)}`);
    }
  }
  return { cannotFollow };
}

async function profilesActiveFirst(adapter: InstanceAdapter): Promise<string[]> {
  const [active, listed] = await Promise.all([adapter.activeProfile(), adapter.profiles()]);
  return [active, ...listed.filter((profile) => profile !== active)];
}

// A mod's folder moves before its lines, so a failed line costs that profile the mod's place (mods.md, Rename mod,
// story 4).
function entryDefinition(adapter: InstanceAdapter, sourceFolder: FolderMove | undefined): EntryOwner<EntryRef> {
  return {
    async plan(entry, to) {
      // A name the manager folds to nothing gives no folder and no line.
      if (adapter.entryKey({ kind: entry.kind, name: to }) === adapter.entryKey({ kind: entry.kind, name: '' })) {
        return { refused: `Not a valid ${entry.kind} name: "${to}"` };
      }
      let from: string | undefined;
      let ordered: string[];
      try {
        [from, ordered] = await Promise.all([folderOf(adapter, entry), profilesActiveFirst(adapter)]);
      } catch (err) {
        return { refused: errorMessage(err) };
      }
      return {
        changes: NO_FILE_CHANGES,
        cannotFollow: [],
        commit: async () => {
          try {
            if (entry.kind === 'mod') await adapter.renameModFolder(entry.name, to);
          } catch (err) {
            return { failed: errorMessage(err) };
          }
          const lines = await linesRenamed(adapter, entry, to, ordered);
          if ('failed' in lines) return lines;
          const moved = await folderOf(adapter, { kind: entry.kind, name: to });
          const folders = from === undefined || moved === undefined ? [] : [{ from, to: moved }];
          const cannotFollow = [
            ...lines.cannotFollow,
            ...await followed('the instance repository', () => adapter.followFoldersInRepository([...folders, ...sourceFolder === undefined ? [] : [sourceFolder]])),
            ...await followed('its publisher tags', () => adapter.followModFolders(folders)),
          ];
          return cannotFollow.length === 0 ? COMMITTED : { cannotFollow };
        },
      };
    },
  };
}

async function sourceFolderNamedFor(adapter: InstanceAdapter, mod: string): Promise<string | undefined> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const folder = sourceMods.folderOf(mod);
  return folder !== undefined && sameName(basename(folder), mod) ? folder : undefined;
}

async function modOwners({ adapter, client }: EntryRenameAccess, from: string, to: string): Promise<SymbolOwners<EntryOwner<EntryRef>>> {
  const sourceFolder = await sourceFolderNamedFor(adapter, from);
  const movedTo = sourceFolder === undefined ? undefined : adapter.sourceFolder(to);
  const move = sourceFolder === undefined || movedTo === undefined ? undefined : { from: sourceFolder, to: movedTo };
  const manifest = manifestEntryReferences({ modFolderOf: (mod) => adapter.modFolderPath(mod), sourceFolder: move?.from });
  const source = sourceFolderMove(client, async (symbol, newName) => move && { ...move, files: await manifest.sourceFilesOf(symbol, newName) });
  return { definition: entryDefinition(adapter, move), references: [manifest, source] };
}

type Refusal = (adapter: InstanceAdapter, requested: string, own: string) => Promise<string | undefined>;

/** A rename that landed names what it landed as: the mod manager may give a name in its own form. */
export type EntryRenameResult = Exclude<ChangeResult, { readonly applied: true }> | { readonly applied: true; readonly cannotFollow: readonly string[]; readonly name: string };

async function renameEntry(
  access: EntryRenameAccess, { held, apply }: RenameEditing, entry: EntryRef, to: string, refusalOf: Refusal,
  ownersOf: () => Promise<SymbolOwners<EntryOwner<EntryRef>>>,
): Promise<EntryRenameResult> {
  let owners: SymbolOwners<EntryOwner<EntryRef>>;
  try {
    const refusal = await refusalOf(access.adapter, to, entry.name);
    if (refusal !== undefined) return { applied: false, refusal };
    owners = await ownersOf();
  } catch (err) {
    return refuse(err);
  }
  const result = await change(owners, (owner) => owner.plan(entry, to, held), apply);
  if (!result.applied) return result;
  const renamed = { kind: entry.kind, name: to };
  const listed = await access.adapter.modOrder().then(({ mods }) => mods.find((each) => sameEntry(access.adapter, each, renamed))?.name, () => undefined);
  return { ...result, name: listed ?? to };
}

// mods.md, Rename mod.
function renameMod(access: EntryRenameAccess, editing: RenameEditing, from: string, to: string): Promise<EntryRenameResult> {
  if (to.trim() === '') return Promise.resolve({ applied: false, refusal: EMPTY_MOD_NAME });
  return renameEntry(access, editing, { kind: 'mod', name: from }, to, renameModNameRefusal, () => modOwners(access, from, to));
}

// mods.md, Rename separator.
function renameSeparator(access: EntryRenameAccess, editing: RenameEditing, from: string, to: string): Promise<EntryRenameResult> {
  return renameEntry(access, editing, { kind: 'separator', name: from }, to, separatorNameRefusal,
    () => Promise.resolve({ definition: entryDefinition(access.adapter, undefined), references: [] }));
}

/** The rename commands of mods and separators, bound to one instance and mEdit. */
export function entryRenameCommands(access: EntryRenameAccess) {
  return {
    renameMod: (...args: TailOf<typeof renameMod>) => renameMod(access, ...args),
    renameSeparator: (...args: TailOf<typeof renameSeparator>) => renameSeparator(access, ...args),
  };
}

export type EntryRenameCommands = ReturnType<typeof entryRenameCommands>;
