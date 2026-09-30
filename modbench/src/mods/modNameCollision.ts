import { modNameCollisionRefusal } from '../install/install';
import { modNameTaken, type ModlistAccess } from '../modlist/modlist';

/** Why a new mod may not take `name`: a folder already holds a mod of that name, matched as the
 *  instance matches names. Undefined for a free name, or a blank one. */
export async function collidingModName(access: ModlistAccess, name: string): Promise<string | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return (await modNameTaken(access, trimmed)) ? modNameCollisionRefusal(trimmed) : undefined;
}
