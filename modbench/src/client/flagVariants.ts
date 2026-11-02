import { isRefused, type MEditClient } from './MEditClient';

/** A plugin's bytes with some of its load flags flipped: the values those flags then hold, and the hash of the bytes. */
interface FlagVariant {
  readonly flags: Readonly<Record<string, boolean>>;
  readonly hash: string;
}

/** The variants of each plugin file at `paths`, by path. Rejects, naming why, when mEdit refuses the call or a file. */
type FlagVariantsOf = (paths: readonly string[]) => Promise<ReadonlyMap<string, readonly FlagVariant[]>>;

export const flagVariantsThrough = (client: Pick<MEditClient, 'pluginFileFlagVariants'>, gameRelease: string): FlagVariantsOf =>
  async (paths) => {
    const answer = await client.pluginFileFlagVariants(gameRelease, paths);
    if (isRefused(answer)) throw new Error(answer.message);
    const [refused] = answer.refused;
    if (refused !== undefined) throw new Error(`${refused.item}: ${refused.message}`);
    return new Map(answer.applied.map(({ path, variants }) => [path, variants]));
  };
