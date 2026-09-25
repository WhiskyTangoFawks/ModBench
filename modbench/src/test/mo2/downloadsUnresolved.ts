import type { DownloadsDirectoryResolver } from '../../instanceAdapter/downloadsDirectory';

/** The Instance adapter's answer for a download_directory it cannot resolve: the Instance lists
 *  no downloads and watches none, for a test whose subject holds no download. */
export const resolvesNoDownloads: DownloadsDirectoryResolver = () =>
  Promise.resolve({ kind: 'unresolved', reason: 'this test reads no downloads' });
