import type { InstanceValue } from './instance';

/** The mods whose manifests can name a plugin: the enabled mods of a repository, in mod order. */
export const modsWithManifests = ({ holdsRepository, mods }: Pick<InstanceValue, 'holdsRepository' | 'mods'>): string[] =>
  holdsRepository ? mods.flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [entry.name] : [])) : [];

/** The plugin lines the listed Data folder holds no file for. */
export const linesWithoutFile = ({ dataFolderPlugins, plugins }: Pick<InstanceValue, 'dataFolderPlugins' | 'plugins'>): string[] =>
  dataFolderPlugins.kind === 'listed' ? plugins.filter(({ path }) => path === undefined).map(({ name }) => name) : [];
