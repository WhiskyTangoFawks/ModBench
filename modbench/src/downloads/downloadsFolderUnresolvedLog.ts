import type { InstanceValue } from '../instanceLoader/instance';

export function downloadsFolderUnresolvedLine({ downloads }: InstanceValue): string | undefined {
  return downloads.kind === 'unresolved' ? downloads.reason : undefined;
}
