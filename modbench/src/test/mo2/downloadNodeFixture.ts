import { DownloadNode } from '../../downloads/DownloadsProvider';
import type { DownloadFile } from '../../instanceLoader/instance';

export const downloadNodeFixture = (row: DownloadFile): DownloadNode => new DownloadNode(row, []);
