// The Instance adapter as a mod manager's implementation and a publisher's make it together
// (ADR-0024): the mod manager answers everything but the publisher's configuration.

import type { InstanceAdapter, InstanceReading, PublisherConfiguration, PublisherTag, Subscription } from './instanceAdapter';
import type { PathSpelling, TokenProgram } from './pathTokens';

export type ManagerReading = Omit<InstanceReading, 'publisherConfiguration'>;

export type ManagerAdapter = Omit<InstanceAdapter, 'reading' | 'publisherTags' | 'changePublisherTag' | 'followModFolders' | 'publisherConfigurationRefusal'> & { reading(): Promise<ManagerReading> };

/** A configuration file, from the instance root, and how it spells a path. */
export interface ConfigurationFile {
  readonly name: string;
  readonly spelling: PathSpelling;
  /** What the file holds of this machine alone, blanked when git holds the file. */
  readonly blanked?: TokenProgram;
}

export interface Publisher {
  readonly tags: readonly PublisherTag[];
  readonly configurationFile: ConfigurationFile;
  configuration(): Promise<PublisherConfiguration>;
  changeTag: InstanceAdapter['changePublisherTag'];
  followFolders: InstanceAdapter['followModFolders'];
  /** Hears that the publisher's configuration changed. */
  subscribe(listener: () => void): Subscription;
}

export function withPublisher(manager: ManagerAdapter, publisher: Publisher): InstanceAdapter {
  return {
    ...manager,
    publisherTags: publisher.tags,
    changePublisherTag: publisher.changeTag,
    followModFolders: publisher.followFolders,
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
