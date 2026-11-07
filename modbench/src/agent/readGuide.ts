import { z } from 'zod';
import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import { GUIDES, INSTANCE_GUIDE_BY_MANAGER } from './instructions/guides';

const GUIDE_BY_TOPIC = new Map<string, string>(Object.entries(GUIDES));

export const READ_GUIDE = {
  name: 'read_guide',
  input: { topic: z.enum(['instance', ...GUIDE_BY_TOPIC.keys()]) },
  of: ({ managerNames: { manager } }: InstanceValue, { topic }: { topic: string }): string => {
    const guide = topic === 'instance' ? INSTANCE_GUIDE_BY_MANAGER[manager] : GUIDE_BY_TOPIC.get(topic);
    if (guide === undefined) throw new Refusal(`No ${topic} guide for ${manager}.`);
    return guide;
  },
};
