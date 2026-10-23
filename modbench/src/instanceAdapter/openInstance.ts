// The one place the build chooses its mod manager's and its publisher's implementations of the Instance adapter.

import type { InstanceAdapter } from './instanceAdapter';
import { isMo2Instance, mo2InstanceAdapter, type Mo2InstanceOptions } from './mo2/mo2Instance';
import { withPublisher } from './publisher';
import { wabbajackPublisher } from './wabbajack/wabbajackPublisher';

export const isInstance = isMo2Instance;
export const adapterForInstance = (options: Mo2InstanceOptions): InstanceAdapter =>
  withPublisher(mo2InstanceAdapter(options), wabbajackPublisher(options.instanceRoot));
