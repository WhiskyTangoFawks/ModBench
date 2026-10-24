// The Instance adapter as a mod manager's implementation and a publisher's make it together
// (ADR-0024): the mod manager answers everything but the publisher's configuration.

import type { InstanceAdapter, InstanceReading, PublisherConfiguration, PublisherTag, Subscription } from './instanceAdapter';
import type { PathSpelling, TokenProgram } from './pathTokens';

export type ManagerReading = Omit<InstanceReading, 'publisherConfiguration'>;

export type ManagerAdapter = Omit<InstanceAdapter, 'reading' | 'publisherTags' | 'changePublisherTag' | 'followModFolders' | 'publisherConfigurationRefusal' | 'keepOutOfPublisher'> & {
  reading(): Promise<ManagerReading>;
  /** Each file (absolute) Modbench keeps in the instance. */
  filesKept(): Promise<KeptFiles>;
};

/** A configuration file, from the instance root, and how it spells a path. */
export interface ConfigurationFile {
  readonly name: string;
  readonly spelling: PathSpelling;
  /** What the file holds of this machine alone, blanked when git holds the file. */
  readonly blanked?: TokenProgram;
}

/** The files Modbench keeps in the instance, all absolute paths. */
export interface KeptFiles {
  readonly present: readonly string[];
  /** Whether a path is one of the shapes Modbench keeps a file at, there now or not. */
  readonly owns: (path: string) => boolean;
}

export interface Publisher {
  readonly tags: readonly PublisherTag[];
  readonly configurationFile: ConfigurationFile;
  configuration(): Promise<PublisherConfiguration>;
  changeTag: InstanceAdapter['changePublisherTag'];
  followFolders: InstanceAdapter['followModFolders'];
  /** Lists each present file in the publisher's ignore list unless an entry already covers it, and drops an entry that
   *  names an owned path no present file has, leaving every other entry as written. Rejects, writing nothing, for a
   *  configuration it cannot read; does nothing when the instance holds none. */
  keepOut(kept: KeptFiles): Promise<void>;
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
    publisherConfigurationRefusal: async () => {
      const configuration = await publisher.configuration();
      return configuration.kind === 'unreadable' ? configuration.reason : undefined;
    },
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
