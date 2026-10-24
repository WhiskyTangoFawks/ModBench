import { describe, it, expect } from 'vitest';
import { downloadsFolderUnresolvedLine } from '../downloadsFolderUnresolvedLog';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { InstanceValue } from '../../instanceLoader/instance';

const REASON = "download_directory \"D:\\Games\\downloads\" could not be resolved: "
  + "Cannot translate Wine drive letter 'D:' in 'D:\\Games\\downloads': only Z: and C: are translated";

describe('the downloads folder unresolved, in the Output', () => {
  it.each<[string, InstanceValue['downloadedFiles'], string | undefined]>([
    ['is a line naming the reason', { kind: 'unresolved', reason: REASON }, REASON],
    ['is no line while the folder is resolved', { kind: 'listed', rows: [] }, undefined],
  ])('%s', (_case, downloadedFiles, line) => {
    expect(downloadsFolderUnresolvedLine(instanceValueFixture({ downloadedFiles }))).toBe(line);
  });
});
