// The one place the build chooses its mod manager's and its publisher's implementations of the Instance adapter.

import type { InstanceAdapter } from './instanceAdapter';
import { enabledModsIn, isMo2Instance, mo2InstanceAdapter, overwriteDir, type Mo2InstanceOptions } from './mo2/mo2Instance';
import { withPublisher } from './publisher';
import { wabbajackPublisher } from './wabbajack/wabbajackPublisher';

export const isInstance = isMo2Instance;
export function adapterForInstance(options: Mo2InstanceOptions): InstanceAdapter {
  const publisher = wabbajackPublisher(options.instanceRoot, { neverShipped: [overwriteDir(options.instanceRoot)], enabledMods: enabledModsIn(options.instanceRoot) });
  return withPublisher(mo2InstanceAdapter({ ...options, publisherConfigurationFile: publisher.configurationFile }), publisher);
}
