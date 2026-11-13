import { describe, it, expect } from 'vitest';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { reportUnwatchedFolders } from '../unwatchedFolders';

describe('the folders Modbench cannot watch', () => {
  it('notifies once of each folder, naming it and why, and again once its watch fails anew', () => {
    const message = 'A change shows only after a refresh in each folder Modbench cannot watch';
    const textures = { folder: '/instance/mods/A/textures', reason: 'EACCES: permission denied' };
    const meshes = { folder: '/instance/mods/A/meshes', reason: 'ENOSPC: System limit for number of file watchers reached' };
    const instance = new FakeInstance(instanceValueFixture(), 0);
    const reporter = recordingReporter();
    reportUnwatchedFolders(instance, reporter);

    for (const unwatchedFolders of [[textures], [textures], [textures, meshes], [], [textures]]) instance.publish(instanceValueFixture({ unwatchedFolders }));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message, detail: '"/instance/mods/A/textures" (EACCES: permission denied)' },
      { severity: 'warning', message, detail: '"/instance/mods/A/meshes" (ENOSPC: System limit for number of file watchers reached)' },
      { severity: 'warning', message, detail: '"/instance/mods/A/textures" (EACCES: permission denied)' },
    ]);
  });
});
