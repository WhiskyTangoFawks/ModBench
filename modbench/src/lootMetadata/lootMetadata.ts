import { errorMessage } from '../ports/errorMessage';
import { METADATA_BRANCH, metadataProblem, type MetadataTexts } from '../sortingRules/lootMetadata';
import { lootRepositoryOf } from '../tables/gamePaths';

const RAW = 'https://raw.githubusercontent.com/loot';
const PRELUDE_REPOSITORY = 'prelude';

type Fetched = ({ found: true } & MetadataTexts) | { found: false; reason: string };

export interface LootMetadata {
  /** The masterlist of the game `release` names and LOOT's prelude, in the metadata version Modbench reads; a refusal for texts that do not read as LOOT metadata. */
  fetch: (release: string) => Promise<Fetched>;
}

interface LootMetadataDeps {
  fetch: (url: string) => Promise<Response>;
}

export function createLootMetadata({ fetch }: LootMetadataDeps): LootMetadata {
  const read = async (what: string, url: string): Promise<{ text: string } | { reason: string }> => {
    const response = await fetch(url);
    return response.ok ? { text: await response.text() } : { reason: `LOOT did not serve the ${what}: ${response.status}` };
  };
  return {
    fetch: async (release) => {
      const repository = lootRepositoryOf(release);
      if (repository === undefined) return { found: false, reason: `Modbench knows no LOOT repository for ${release}.` };
      try {
        const [masterlist, prelude] = await Promise.all([
          read('masterlist', `${RAW}/${repository}/${METADATA_BRANCH}/masterlist.yaml`),
          read('prelude', `${RAW}/${PRELUDE_REPOSITORY}/${METADATA_BRANCH}/prelude.yaml`),
        ]);
        if ('reason' in masterlist) return { found: false, reason: masterlist.reason };
        if ('reason' in prelude) return { found: false, reason: prelude.reason };
        const texts = { masterlist: masterlist.text, prelude: prelude.text };
        const problem = metadataProblem(texts);
        return problem === undefined ? { found: true, ...texts } : { found: false, reason: problem };
      } catch (err) {
        return { found: false, reason: `Could not reach LOOT: ${errorMessage(err)}` };
      }
    },
  };
}
