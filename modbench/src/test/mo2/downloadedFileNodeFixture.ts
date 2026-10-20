import { DownloadedFileNode } from '../../downloads/DownloadsProvider';
import type { LocatedDownloadedFileRow } from '../../instanceLoader/instance';

export const downloadedFileNodeFixture = (row: LocatedDownloadedFileRow): DownloadedFileNode => new DownloadedFileNode(row);
