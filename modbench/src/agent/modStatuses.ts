import type { InstanceValue } from '../instanceLoader/instance';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import type { ModStatuses } from '../modStatus/modStatuses';
import { Refusal } from '../drivingLib/refusal';
import { modOrigin } from '../instanceLoader/fileConflictIndex';
import { filesOfOrigin } from '../drivingLib/copiesToRead';
import { FILTER, filterNarrows, fitting, holding } from './tooLarge';

const LEFT_OUT = new Set<string>(['mod', 'heldWhole', 'manifestFile', 'packages', 'ignored', 'ignoreEntries'] satisfies (keyof ModStatus)[]);

const HELD_AT_FOLDER_PATHS = new Set<string>(['differing', 'namedByNoLine'] satisfies (keyof ModStatus)[]);

const isHeld = (member: unknown): boolean =>
  member === true || ((typeof member === 'string' || Array.isArray(member)) && member.length > 0);

const isHeldBuildFile = (member: unknown): boolean =>
  typeof member === 'object' && member !== null && 'lacks' in member && 'unreadable' in member && (isHeld(member.lacks) || isHeld(member.unreadable));

export const LIST_MOD_STATUSES = {
  name: 'list_mod_statuses',
  input: FILTER,
  of: async (value: InstanceValue, statuses: Pick<ModStatuses, 'current'>, { filter }: { filter?: string }) => {
    if (!value.holdsRepository) throw new Refusal('The instance is not a repository, so no mod has a manifest to compare. Request git init first.');
    const derived = await statuses.current();
    const nameOf = new Map((value.modFolders ?? []).filter(({ kind }) => kind === 'mod').map(({ modName, name }) => [modName, name]));
    const held = holding(filter);
    const groups = new Map<string, { mods: string[] }>();
    for (const read of derived.values()) {
      const name = nameOf.get(read.mod);
      if (name === undefined || !held(name)) continue;
      const ownPaths = new Map(filesOfOrigin(value, modOrigin(name)).map(({ relativePath, includedPath }) => [relativePath, includedPath]));
      const named = (member: string, held: unknown) =>
        (HELD_AT_FOLDER_PATHS.has(member) && Array.isArray(held) ? held.map((path: string) => ownPaths.get(path) ?? path) : held);
      const present = Object.fromEntries(Object.entries<unknown>({ ...read })
        .filter(([member, held]) => !LEFT_OUT.has(member) && (member === 'buildFile' ? isHeldBuildFile(held) : isHeld(held))).map(([member, held]) => [member, named(member, held)]));
      const key = JSON.stringify(present);
      const group = groups.get(key) ?? { mods: [], ...present };
      group.mods.push(name);
      groups.set(key, group);
    }
    return fitting([...groups.values()], (all) => filterNarrows({ mods: all.reduce((count, { mods }) => count + mods.length, 0) }, 'the mods whose name holds it'));
  },
};
