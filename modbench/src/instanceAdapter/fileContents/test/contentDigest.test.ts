import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { expectKind } from '../../../test/expectKind';
import { mo2InstanceHolding } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

describe('a file\'s hash, as mEdit\'s manifest carries it', () => {
  it.each([
    ['hello', 'o22fiH2CxyY='],
    ['kept', 'gO3vE0ddOto='],
    ['vanilla', '/Qk9lLVYbZs='],
  ])('answers the hash of %s that mEdit\'s manifest carries: xxHash64, its eight little-endian bytes in base64', async (body, hash) => {
    const { root, adapter } = mo2InstanceHolding({ 'mods/M/a.esp': body });
    expect(await adapter.originFileHash(join(root, 'mods', 'M', 'a.esp'))).toEqual({ kind: 'read', answer: { size: body.length, hash } });
  });

  it('answers why when the file cannot be read, so the caller answers the reason', async () => {
    const { root, adapter } = mo2InstanceHolding();
    expect(await adapter.originFileHash(join(root, 'mods', 'M', 'none.dds'))).toEqual({ kind: 'unreadable', reason: expect.stringContaining('ENOENT') as unknown });
  });
});

describe('a text\'s hash', () => {
  it('is the hash of its UTF-8 bytes, as a game folder package\'s pin is in a manifest', async () => {
    expect(await mo2InstanceHolding().adapter.textHash('a.dds\nM5WSec/sW34=\nmeshes/b.nif\nMr+EvxoNp0I=\n')).toBe('U6/ScIuKmyg=');
  });
});

describe('a file\'s MD5', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['hello', '5d41402abc4b2a76b9719d911017c592'],
  ])('answers the hex MD5 of %j', async (body, md5) => {
    const { adapter } = mo2InstanceHolding({ 'downloads/a.7z': body });
    expect(expectKind(await adapter.downloadedFileQuery('a.7z'), 'read').answer?.md5).toBe(md5);
  });
});
