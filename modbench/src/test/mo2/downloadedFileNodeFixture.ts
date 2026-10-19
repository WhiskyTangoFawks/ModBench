import { DownloadedFileNode } from '../../downloads/DownloadsProvider';
import type { DownloadFile } from '../../instanceLoader/instance';

export const downloadedFileNodeFixture = (row: DownloadFile): DownloadedFileNode => new DownloadedFileNode(row);
