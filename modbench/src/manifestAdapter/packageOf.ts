import type { Manifest, ManifestFile, ManifestPackage } from './manifest';

/** The package a line's file comes from: the one the line names, else the manifest's first. */
export const packageOf = (manifest: Manifest, line: ManifestFile): ManifestPackage | undefined =>
  (line.package === undefined ? manifest.packages[0] : manifest.packages.find(({ name }) => name === line.package));
