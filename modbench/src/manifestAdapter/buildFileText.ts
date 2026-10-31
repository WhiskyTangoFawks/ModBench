import type { BuildFile, BuildFileLine, BuildFilePackage } from './buildFile';
import { ordinal, ordinalIgnoreCaseThenOrdinal } from './manifestText';

const objectText = (members: readonly (readonly [string, string])[]): string =>
  `{${members.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;

const packageLine = (pkg: BuildFilePackage): string => {
  const members: [string, string][] = [];
  if (pkg.kind === 'installationFile') {
    members.push(['installationFile', JSON.stringify(pkg.name)], ['size', JSON.stringify(pkg.size)], ['hash', JSON.stringify(pkg.hash)]);
    if (pkg.page !== undefined) members.push(['page', JSON.stringify(pkg.page)]);
  } else {
    members.push(['gameFolder', JSON.stringify(pkg.name)], ['hash', JSON.stringify(pkg.hash)]);
    if (pkg.depots.length > 0) {
      members.push(['depots', objectText([...pkg.depots].sort((a, b) => ordinal(a.id, b.id)).map((depot) => [depot.id, JSON.stringify(depot.version)]))]);
    }
  }
  return objectText(members);
};

const fileLine = (file: BuildFileLine, first: string | undefined): object => {
  const members: Record<string, unknown> = { path: file.path };
  if (file.package !== undefined && file.package !== first) members.package = file.package;
  switch (file.entry.kind) {
    case 'heldAt':
      members.packagePath = file.entry.path;
      break;
    case 'notHeld':
      members.inPackage = false;
      break;
    case 'otherBytes':
      members.otherBytes = true;
      break;
    case 'madeByStep':
      members.madeByStep = true;
      break;
    case 'held':
      break;
  }
  return members;
};

const lineEach = (key: string, items: readonly (object | string)[]): string[] =>
  items.length === 0 ? [] : [`"${key}": [\n${items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(',\n')}\n]`];

export function buildFileText(buildFile: BuildFile): string {
  const first = buildFile.packages[0]?.name;
  const files = [...buildFile.files].sort((a, b) => ordinalIgnoreCaseThenOrdinal(a.path, b.path));
  const members = [
    ...lineEach('packages', buildFile.packages.map(packageLine)),
    ...(buildFile.archives.length === 0
      ? []
      : [`"archives": {\n${buildFile.archives.map((archive) => `${JSON.stringify(archive.path)}: ${JSON.stringify(archive.files)}`).join(',\n')}\n}`]),
    ...lineEach('steps', buildFile.steps.map((step) => (step.args.length === 0 ? { task: step.task } : { task: step.task, args: step.args }))),
    ...lineEach('tools', buildFile.tools),
    ...(files.length === 0 ? ['"files": []'] : lineEach('files', files.map((file) => fileLine(file, first)))),
  ];
  return `{\n${members.join(',\n')}\n}\n`;
}

/** The text a game folder package's pin is the hash of: each file the build takes by its path and hash, in the order a
 *  manifest lists paths. */
export const pinText = (files: readonly { readonly path: string; readonly hash: string }[]): string =>
  [...files].sort((a, b) => ordinalIgnoreCaseThenOrdinal(a.path, b.path)).map(({ path, hash }) => `${path}\n${hash}\n`).join('');
