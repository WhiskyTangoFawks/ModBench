import { describe, it, expect, vi } from 'vitest';
import { deleteDownload, type DeleteDownloadDeps } from './deleteDownload';

const META = '/dl/foo.zip.meta';
const ARCHIVE = '/dl/foo.zip';

function deps(over: Partial<DeleteDownloadDeps> = {}): DeleteDownloadDeps {
  return {
    archivePath: ARCHIVE,
    metaPath: META,
    confirm: vi.fn(() => Promise.resolve(true)),
    metaExists: vi.fn(() => Promise.resolve(true)),
    trash: vi.fn(() => Promise.resolve()),
    reportFailure: vi.fn(),
    ...over,
  };
}

describe('deleteDownload', () => {
  it('does nothing and surfaces no error when the user cancels the confirmation', async () => {
    const d = deps({ confirm: vi.fn(() => Promise.resolve(false)) });
    await deleteDownload(d);
    expect(d.trash).not.toHaveBeenCalled();
    expect(d.reportFailure).not.toHaveBeenCalled();
  });

  it('on confirm with a .meta present, trashes the .meta THEN the archive, in that order', async () => {
    const order: string[] = [];
    const d = deps({ trash: vi.fn((p: string) => { order.push(p); return Promise.resolve(); }) });
    await deleteDownload(d);
    expect(order).toEqual([META, ARCHIVE]);
    expect(d.reportFailure).not.toHaveBeenCalled();
  });

  it('on confirm with no .meta, trashes only the archive and surfaces no error over the missing sidecar', async () => {
    const d = deps({ metaExists: vi.fn(() => Promise.resolve(false)) });
    await deleteDownload(d);
    expect(d.trash).toHaveBeenCalledTimes(1);
    expect(d.trash).toHaveBeenCalledWith(ARCHIVE);
    expect(d.reportFailure).not.toHaveBeenCalled();
  });

  it('surfaces the error (ADR-0026) when a trash operation fails', async () => {
    const d = deps({ trash: vi.fn(() => Promise.reject(new Error('EPERM'))) });
    await deleteDownload(d);
    expect(d.reportFailure).toHaveBeenCalledWith('EPERM');
  });
});
