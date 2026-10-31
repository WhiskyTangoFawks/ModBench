import type { Manifest, ManifestFile, ManifestPackage } from './manifest';

type RepositoryPackage = Extract<ManifestPackage, { kind: 'sourceRepository' }>;

type InstallationFilePackage = Extract<ManifestPackage, { kind: 'installationFile' }>;

/** The package a line's file comes from: the one the line names, else the manifest's first. */
export const packageOf = (manifest: Manifest, line: ManifestFile): ManifestPackage | undefined =>
  (line.package === undefined ? manifest.packages[0] : manifest.packages.find(({ name }) => name === line.package));

/** The repository package `manifest` names, which makes its folder a source mod's. */
export const repositoryOf = (manifest: Manifest): RepositoryPackage | undefined =>
  manifest.packages.find((pkg): pkg is RepositoryPackage => pkg.kind === 'sourceRepository');

/** The installation file package of `packages` named `name`. */
export const installationFileIn = (packages: readonly ManifestPackage[], name: string | undefined): InstallationFilePackage | undefined =>
  packages.find((pkg): pkg is InstallationFilePackage => pkg.kind === 'installationFile' && pkg.name === name);
