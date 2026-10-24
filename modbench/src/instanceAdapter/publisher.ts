// The Instance adapter as a mod manager's implementation and a publisher's make it together
// (ADR-0024): the mod manager answers everything but the publisher's configuration.

import type { InstanceAdapter, InstanceReading, PublisherConfiguration, PublisherTag, Subscription } from './instanceAdapter';
import type { PathSpelling, TokenProgram } from './pathTokens';

export type ManagerReading = Omit<InstanceReading, 'publisherConfiguration'>;

export type ManagerAdapter = Omit<InstanceAdapter, 'reading' | 'publisherTags' | 'changePublisherTag' | 'followModFolders' | 'publisherConfigurationRefusal' | 'keepOutOfPublisher'> & {
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
  /** Rejects, writing nothing, for a configuration it cannot read; does nothing when the instance holds none.
   *  Answers the call that takes back what it wrote. */
  keepOut(kept: KeptFiles): Promise<() => Promise<void>>;
  /** Hears that the publisher's configuration changed. */
  subscribe(listener: () => void): Subscription;
}

export function withPublisher(manager: ManagerAdapter, publisher: Publisher): InstanceAdapter {
  return {
    ...manager,
    publisherTags: publisher.tags,
    changePublisherTag: publisher.changeTag,
    followModFolders: publisher.followFolders,
    keepOutOfPublisher: async () => publisher.keepOut(await manager.filesKept()),
    publisherConfigurationRefusal: () => publisher.refusal(),
    reading: async () => {
      const [reading, publisherConfiguration] = await Promise.all([manager.reading(), publisher.configuration()]);
      return { ...reading, publisherConfiguration };
    },
    subscribe: (listener) => {
      const heard = [manager.subscribe(listener), publisher.subscribe(listener)];
      return { dispose: () => { for (const subscription of heard) subscription.dispose(); } };
    },
  };
}
