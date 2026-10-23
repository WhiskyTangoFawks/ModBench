// The Instance adapter as a mod manager's implementation and a publisher's make it together
// (ADR-0024): the mod manager answers everything but the publisher's configuration.

import type { InstanceAdapter, InstanceReading, PublisherConfiguration, PublisherTag, Subscription } from './instanceAdapter';

export type ManagerReading = Omit<InstanceReading, 'publisherConfiguration'>;

export type ManagerAdapter = Omit<InstanceAdapter, 'reading' | 'publisherTags'> & { reading(): Promise<ManagerReading> };

export interface Publisher {
  readonly tags: readonly PublisherTag[];
  configuration(): Promise<PublisherConfiguration>;
  /** Hears that the publisher's configuration changed. */
  subscribe(listener: () => void): Subscription;
}

export function withPublisher(manager: ManagerAdapter, publisher: Publisher): InstanceAdapter {
  return {
    ...manager,
    publisherTags: publisher.tags,
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
