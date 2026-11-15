import type { InstanceValue } from '../instanceLoader/instance';

export function downloadsFolderUnresolvedLine({ downloadedFiles }: Pick<InstanceValue, 'downloadedFiles'>): string | undefined {
  return downloadedFiles.kind === 'unresolved' ? downloadedFiles.reason : undefined;
}
