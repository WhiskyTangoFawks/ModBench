import { describe, expect, it } from 'vitest';
import { leaveWritesUnnamed, nameWrites } from '../../ports/writeNaming';
import { WrittenFiles } from '../writtenFiles';

describe('the files a write wrote', () => {
  it('are those every write inside collecting named', async () => {
    const written = new WrittenFiles();

    await written.collecting(async () => {
      nameWrites('/a');
      await Promise.resolve();
      nameWrites('/b', '/a');
    });

    expect(written.named).toEqual(['/a', '/b']);
  });

  it('are none named when the write named none, so the whole disk is checked', async () => {
    const written = new WrittenFiles();

    await written.collecting(() => Promise.resolve());

    expect(written.named).toBeUndefined();
  });

  it('are none named when one write says its files cannot be told, though another named its own', async () => {
    const written = new WrittenFiles();

    await written.collecting(() => {
      nameWrites('/a');
      leaveWritesUnnamed();
      return Promise.resolve();
    });

    expect(written.named).toBeUndefined();
  });

  it('reach the collector around a nested one, which keeps its own', async () => {
    const around = new WrittenFiles();
    const inner = new WrittenFiles();

    await around.collecting(() => inner.collecting(() => { nameWrites('/nested'); return Promise.resolve(); }));

    expect([around.named, inner.named]).toEqual([['/nested'], ['/nested']]);
  });

  it('are named by no write outside a collector', () => {
    nameWrites('/outside');

    expect(new WrittenFiles().named).toBeUndefined();
  });
});
