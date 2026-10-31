// The Instance adapter as a mod manager's implementation and a publisher's make it together
// (ADR-0024): the mod manager answers everything but the publisher's configuration.

import type { InstanceAdapter, InstanceReading, PublisherConfiguration, PublisherTag, Subscription } from './instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { PathSpelling, TokenProgram } from './pathTokens';

export type ManagerReading = Omit<InstanceReading, 'publisherConfiguration'>;

export type ManagerAdapter = Omit<InstanceAdapter, 'reading' | 'publisherTags' | 'changePublisherTag' | 'followModFolders' | 'publisherConfigurationRefusal' | 'scriptEnvironmentFile'> & {
  reading(): Promise<ManagerReading>;
  filesKept(): Promise<KeptFiles>;
};

/** A configuration file, from the instance root, and how it spells a path. */
export interface ConfigurationFile {
  readonly name: string;
  readonly spelling: PathSpelling;
  /** What the file holds of this machine alone, blanked when git holds the file. */
  readonly blanked?: TokenProgram;
}

interface KeptFiles {
  readonly present: readonly string[];
  /** Whether a path is one of the shapes Modbench keeps a file at, there now or not. */
  readonly owns: (path: string) => boolean;
}

export interface Publisher {
  readonly tags: readonly PublisherTag[];
  readonly configurationFile: ConfigurationFile;
  configuration(): Promise<PublisherConfiguration>;
  /** Why the configuration cannot be read, without checking the paths it names. */
  refusal(): Promise<string | undefined>;
  changeTag: InstanceAdapter['changePublisherTag'];
  followFolders: InstanceAdapter['followModFolders'];
  /** Lists each kept file in the ignore list, leaving every other entry as written. Rejects, writing nothing, for a
   *  configuration it cannot read; does nothing when the instance holds none. */
  keepOut(kept: KeptFiles): Promise<void>;
  /** Hears that the publisher's configuration changed. */
  subscribe(listener: () => void): Subscription;
}

const withEnvironmentFile = ({ present, owns }: KeptFiles, environmentFile: string): KeptFiles => ({ present: [...present, environmentFile], owns });

export function withPublisher(manager: ManagerAdapter, publisher: Publisher, scriptEnvironmentFilePath: () => string): Omit<InstanceAdapter, 'scriptEnvironmentFile'> {
  const keepOut = async () => publisher.keepOut(withEnvironmentFile(await manager.filesKept(), scriptEnvironmentFilePath()));
  const afterKeepingOut = async <T>(write: Promise<T>): Promise<T> => {
    const written = await write;
    await keepOut();
    return written;
  };
  return {
    ...manager,
    publisherTags: publisher.tags,
    changePublisherTag: (...change) => afterKeepingOut(publisher.changeTag(...change)),
    followModFolders: (moves) => afterKeepingOut(publisher.followFolders(moves)),
    publisherConfigurationRefusal: () => publisher.refusal(),
    reading: async () => {
      const [reading, publisherConfiguration] = await Promise.all([manager.reading(), keptOutConfiguration()]);
      return { ...reading, publisherConfiguration };
    },
    subscribe: (listener) => {
      const heard = [manager.subscribe(listener), publisher.subscribe(listener)];
      return { dispose: () => { for (const subscription of heard) subscription.dispose(); } };
    },
  };

  async function keptOutConfiguration(): Promise<PublisherConfiguration> {
    try {
      await keepOut();
    } catch (err) {
      return { kind: 'unreadable', reason: errorMessage(err) };
    }
    return publisher.configuration();
  }
}
