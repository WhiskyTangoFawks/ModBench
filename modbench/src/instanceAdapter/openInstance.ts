// The one place the build chooses its mod manager's and its publisher's implementations of the Instance adapter.

import type { InstanceAdapter } from './instanceAdapter';
import { enabledModsIn, isMo2Instance, mo2InstanceAdapter, overwriteDir, type Mo2InstanceOptions } from './mo2/mo2Instance';
import { scriptEnvironmentFile } from './scriptEnvironmentFile';
import { withPublisher } from './publisher';
import { wabbajackPublisher } from './wabbajack/wabbajackPublisher';

export const isInstance = isMo2Instance;
export function adapterForInstance(options: Mo2InstanceOptions & { scriptEnvironmentFileSetting: () => string | undefined }): InstanceAdapter {
  const publisher = wabbajackPublisher(options.instanceRoot, { neverShipped: [overwriteDir(options.instanceRoot)], enabledMods: enabledModsIn(options.instanceRoot) });
  const envFile = scriptEnvironmentFile(options.instanceRoot, options.scriptEnvironmentFileSetting);
  const adapter = withPublisher(mo2InstanceAdapter(options, publisher.configurationFile), publisher, envFile.path);
  return { ...adapter, scriptEnvironmentFile: envFile };
}
