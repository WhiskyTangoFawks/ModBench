import { isRefused, type MEditClient } from './MEditClient';

interface FlagVariant {
  readonly flags: Readonly<Record<string, boolean>>;
  readonly hash: string;
}

type FlagVariantsOf = (paths: readonly string[]) => Promise<ReadonlyMap<string, readonly FlagVariant[]>>;

export const flagVariantsThrough = (client: Pick<MEditClient, 'pluginFileFlagVariants'>, gameRelease: string): FlagVariantsOf =>
  async (paths) => {
    const answer = await client.pluginFileFlagVariants(gameRelease, paths);
    if (isRefused(answer)) throw new Error(answer.message);
    const [refused] = answer.refused;
    if (refused !== undefined) throw new Error(`${refused.item}: ${refused.message}`);
    return new Map(answer.applied.map(({ path, variants }) => [path, variants]));
  };
