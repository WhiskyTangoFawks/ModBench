import { describe, it, expect } from 'vitest';
import { logDownloadsFolderUnresolved } from '../downloadsFolderUnresolvedLog';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const REASON_D_DRIVE = "download_directory \"D:\\Games\\downloads\" could not be resolved: "
  + "Cannot translate Wine drive letter 'D:' in 'D:\\Games\\downloads': only Z: and C: are translated";
const REASON_NO_PREFIX = 'download_directory "C:\\Games\\downloads" could not be resolved: '
  + "Cannot translate Wine path 'C:\\Games\\downloads': the Proton prefix could not be determined";

const LISTED = instanceValueFixture({ downloads: { kind: 'listed', rows: [] } });
const UNRESOLVED = instanceValueFixture({ downloads: { kind: 'unresolved', reason: REASON_D_DRIVE } });

function logged(instance: FakeInstance): string[] {
  const lines: string[] = [];
  logDownloadsFolderUnresolved(instance, (line) => lines.push(line));
  return lines;
}

describe('the downloads folder unresolved, in the Output', () => {
  it('is one line naming the reason', () => {
    const instance = new FakeInstance(LISTED);
    const lines = logged(instance);

    instance.publish(UNRESOLVED);

    expect(lines).toEqual([REASON_D_DRIVE]);
  });

  // Rival: a line per landed value, which every watched file change would repeat.
  it('stays one line over every later value that is still unresolved for the same reason', () => {
    const instance = new FakeInstance(LISTED);
    const lines = logged(instance);

    instance.publish(UNRESOLVED);
    instance.publish(instanceValueFixture({ ...UNRESOLVED, activeProfile: 'Survival' }));
    instance.publish(UNRESOLVED);

    expect(lines).toEqual([REASON_D_DRIVE]);
  });

  it('says nothing while the folder is resolved', () => {
    const instance = new FakeInstance(LISTED);
    const lines = logged(instance);

    instance.publish(LISTED);

    expect(lines).toEqual([]);
  });

  // Rival: a flag set once and never cleared, which would hide the second failure.
  it('is a new line when the folder is unresolved again after being resolved', () => {
    const instance = new FakeInstance(LISTED);
    const lines = logged(instance);

    instance.publish(UNRESOLVED);
    instance.publish(LISTED);
    instance.publish(UNRESOLVED);

    expect(lines).toEqual([REASON_D_DRIVE, REASON_D_DRIVE]);
  });

  it('is a new line when the reason changes', () => {
    const instance = new FakeInstance(LISTED);
    const lines = logged(instance);
    const differently = instanceValueFixture({ downloads: { kind: 'unresolved', reason: REASON_NO_PREFIX } });

    instance.publish(UNRESOLVED);
    instance.publish(differently);

    expect(lines).toEqual([REASON_D_DRIVE, REASON_NO_PREFIX]);
  });
});
