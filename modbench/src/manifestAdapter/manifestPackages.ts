import type { PackagesAsked, RepositoryPin } from '../repositoriesLib/statusValues';
import type { Manifest, ManifestPackage } from './manifest';

type RepositoryPackage = Extract<ManifestPackage, { kind: 'repository' }>;

/** The repository package `manifest`, or a status, names, which makes its folder a source mod's. */
export const repositoryOf = (manifest: Pick<Manifest, 'packages'>): RepositoryPackage | undefined =>
  manifest.packages.find((pkg): pkg is RepositoryPackage => pkg.kind === 'repository');

/** Whether `text` is a URI, which the schema's `url` host takes. */
export const isAddress = (text: string): boolean => URL.canParse(text);

/** A repository package as a problem names it. */
export const repositoryNoun = (name: string): string => `repository '${name}'`;

/** `pkg` as a problem names it when it has no host (instance-repository.md, The manifest, story 5); none when it has one.
 *  `repositoryPin`: what a clone gets of a repository package's repository. */
export function packageWithoutHost(pkg: ManifestPackage, repositoryPin: RepositoryPin): string[] {
  switch (pkg.kind) {
    case 'installationFile': return pkg.host === undefined ? [`installation file '${pkg.name}'`] : [];
    case 'gameFolder': return pkg.host === undefined ? ['the game folder'] : [];
    case 'repository': return repositoryPin === 'none' ? [repositoryNoun(pkg.name)] : [];
  }
}

/** What the Instance adapter is asked to read for a status of `manifest`. */
export function packagesAsked(manifest: Manifest): PackagesAsked {
  const repository = repositoryOf(manifest)?.name;
  return {
    installationFiles: manifest.packages.flatMap((pkg) => (pkg.kind === 'installationFile' ? [pkg.name] : [])),
    ...manifest.packages.some(({ kind }) => kind === 'gameFolder') ? { gameFiles: [...manifest.files.keys()] } : {},
    ...repository === undefined ? {} : { repository },
  };
}
