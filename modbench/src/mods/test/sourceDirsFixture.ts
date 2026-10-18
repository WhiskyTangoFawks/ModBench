import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

export const valueWithSourceDirs = (sourceDirs: ReadonlyMap<string, string>) => instanceValueFixture({
  paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs },
});
