import { describe, expect, it } from 'vitest';
import { lineAtFolderPath, type Manifest, type ManifestFile } from '../manifestAdapter';

const MARK = '.excluded';
const PACK = { kind: 'installationFile', name: 'Pack.zip', size: 10, hash: 'hash' } as const;
const REPOSITORY = { kind: 'sourceRepository', name: 'Mod', isSubmodule: false } as const;

const manifestOf = (exclude: readonly string[]): Manifest =>
  ({ packages: [REPOSITORY, PACK], exclude, archives: [], steps: [], tools: [], files: [] });

describe('lineAtFolderPath', () => {
  it.each([
    ['the file', ['textures/a.dds'], 'textures/a.dds.excluded'],
    ['its folder', ['textures'], 'textures.excluded/a.dds'],
    ['the file in another case', ['Textures/A.dds'], 'textures/a.dds.excluded'],
  ])('moves a taken file\'s line under the mark when the manifest excludes %s, keeping its path in its package', (_case, exclude, at) => {
    const line: ManifestFile = { path: 'textures/a.dds', entry: { kind: 'held' }, package: 'Pack.zip' };

    expect(lineAtFolderPath(manifestOf(exclude), line, MARK)).toEqual({ path: at, entry: { kind: 'heldAt', path: 'textures/a.dds' }, package: 'Pack.zip' });
  });

  it('moves a taken file\'s line back to its own path once the manifest includes it', () => {
    const line: ManifestFile = { path: 'textures/a.dds.excluded', entry: { kind: 'heldAt', path: 'textures/a.dds' }, package: 'Pack.zip' };

    expect(lineAtFolderPath(manifestOf([]), line, MARK)).toEqual({ path: 'textures/a.dds', entry: { kind: 'held' }, package: 'Pack.zip' });
  });

  it('moves a built file\'s line with the folder, as its repository holds it wherever the build writes it', () => {
    const line: ManifestFile = { path: 'textures/a.dds', entry: { kind: 'held' } };

    expect(lineAtFolderPath(manifestOf(['textures/a.dds']), line, MARK)).toEqual({ path: 'textures/a.dds.excluded', entry: { kind: 'held' } });
  });

  it.each<[string, ManifestFile]>([
    ['no package holds', { path: 'textures/a.dds', entry: { kind: 'notHeld' } }],
    ['a step makes', { path: 'textures/a.dds', entry: { kind: 'madeByStep' } }],
    ['its package holds with other bytes', { path: 'textures/a.dds', entry: { kind: 'otherBytes' }, package: 'Pack.zip' }],
  ])('leaves the line of a file %s as written', (_case, line) => {
    expect(lineAtFolderPath(manifestOf(['textures']), line, MARK)).toBe(line);
  });

  it('leaves a line the manifest does not exclude as written', () => {
    const line: ManifestFile = { path: 'meshes/b.nif', entry: { kind: 'held' }, package: 'Pack.zip' };

    expect(lineAtFolderPath(manifestOf(['textures']), line, MARK)).toBe(line);
  });
});
