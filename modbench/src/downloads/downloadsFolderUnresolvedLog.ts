import type { InstanceValue } from '../instanceLoader/instance';

export function downloadsFolderUnresolvedLine({ downloadedFiles }: InstanceValue): string | undefined {
  return downloadedFiles.kind === 'unresolved' ? downloadedFiles.reason : undefined;
}
