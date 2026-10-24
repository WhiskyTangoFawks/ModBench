import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseRoot } from '../releaseRoot';

describe('where a release\'s files start, when it holds links', () => {
  let base: string;
  let extracted: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'release-root-'));
    extracted = join(base, 'extracted');
    await mkdir(extracted);
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  it('takes a link to a Data folder for the Data folder', async () => {
    await mkdir(join(base, 'real'), { recursive: true });
    await symlink(join(base, 'real'), join(extracted, 'Data'));

    expect(await releaseRoot(extracted)).toEqual({ root: join(extracted, 'Data') });
  });

  it('takes a link to a module config file for a FOMOD', async () => {
    await mkdir(join(extracted, 'fomod'));
    await writeFile(join(base, 'config.xml'), '');
    await symlink(join(base, 'config.xml'), join(extracted, 'fomod', 'ModuleConfig.xml'));

    expect(await releaseRoot(extracted)).toEqual({ root: extracted, fomod: 'xml' });
  });

  it('does not unwrap a lone folder when a link to a file sits beside it', async () => {
    await mkdir(join(extracted, 'Wrapper'));
    await writeFile(join(base, 'readme.txt'), '');
    await symlink(join(base, 'readme.txt'), join(extracted, 'readme.txt'));

    expect(await releaseRoot(extracted)).toEqual({ root: extracted });
  });
});
