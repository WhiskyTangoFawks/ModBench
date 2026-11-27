import { GAME_FOLDER_SETTING_ID } from '../../test/gameFolderSetting';
import type { InstanceAdapter, InstanceReading } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { leveledLog } from '../../test/leveledLog';
import { Instance } from '../instance';
import { fakeWorkspace } from '../../test/fakeWorkspace';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

export type Fixture = Partial<InstanceReading> & Partial<Pick<InstanceAdapter, 'fileStamp'>>;

const instances: Instance[] = [];

/** Each Instance `loader` built since the last call, disposed: a test file's `afterEach`. */
export function disposeLoaded(): void {
  for (const instance of instances.splice(0)) instance.dispose();
}

/** An Instance over the fake Instance adapter's reading of `fixture`. */
export function loader({ fileStamp, ...overrides }: Fixture = {}, wrap: (adapter: InstanceAdapter) => InstanceAdapter = (adapter) => adapter, workspace = fakeWorkspace()) {
  const fake = fakeInstanceAdapter(readingFixture(overrides));
  const medit = new InMemoryMEditClient();
  const log = leveledLog();
  const instance = new Instance({
    adapter: wrap(fileStamp === undefined ? fake.adapter : { ...fake.adapter, fileStamp }),
    gameFolderSettingId: GAME_FOLDER_SETTING_ID,
    log,
    medit,
    workspace,
  });
  instances.push(instance);
  return {
    instance, fake, medit, workspace, logs: log.lines.info, warnings: log.lines.warn, errorLines: log.lines.error,
  };
}
