import type { InstanceValue, PublisherTag } from '../instanceLoader/instance';

/** The publisher tags the configuration lists on exactly `path`: what a row holds, and what remove takes away. */
export const tagsHeldAt = ({ publisherConfiguration }: Pick<InstanceValue, 'publisherConfiguration'>, path: string | undefined): readonly PublisherTag[] =>
  (publisherConfiguration.kind === 'read' && path !== undefined ? publisherConfiguration.listed(path) : []);
