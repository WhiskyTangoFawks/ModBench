import type { PackagesAsked } from '../repositoriesLib/statusValues';
import type { Manifest, ManifestPackage } from './manifest';

type RepositoryPackage = Extract<ManifestPackage, { kind: 'repository' }>;

/** The repository package `manifest`, or a status, names, which makes its folder a source mod's. */
export const repositoryOf = (manifest: Pick<Manifest, 'packages'>): RepositoryPackage | undefined =>
  manifest.packages.find((pkg): pkg is RepositoryPackage => pkg.kind === 'repository');

/** Whether `text` is a URI, which the schema's `url` host takes. */
export const isAddress = (text: string): boolean => URL.canParse(text);

/** `pkg` as a problem names it when it has no host (modlist-repository.md, The manifest, story 5); none when it has one.
 *  `repositoryHosted`: whether a repository package's repository is a submodule. */
export function packageWithoutHost(pkg: ManifestPackage, repositoryHosted: boolean): string[] {
  switch (pkg.kind) {
    case 'installationFile': return pkg.host === undefined ? [`installation file '${pkg.name}'`] : [];
    case 'gameFolder': return pkg.host === undefined ? ['the game folder'] : [];
    case 'repository': return repositoryHosted ? [] : [`repository '${pkg.name}'`];
  }
}

/** What the Instance adapter is asked to read for a status of `manifest`. */
export function packagesAsked(manifest: Manifest): PackagesAsked {
  const repository = repositoryOf(manifest)?.name;
  return {
    installationFiles: manifest.packages.flatMap((pkg) => (pkg.kind === 'installationFile' ? [pkg.name] : [])),
    ...manifest.packages.some(({ kind }) => kind === 'gameFolder') ? { gameFiles: [...manifest.files.keys()] } : {},
    ...repository === undefined ? {} : { repository },
    ...manifest.flags.size === 0 ? {} : { flagged: [...manifest.flags].flatMap(([path, flags]) => {
      const hash = manifest.files.get(path);
      return typeof hash === 'string' ? [{ path, hash, flags }] : [];
    }) },
  };
}
