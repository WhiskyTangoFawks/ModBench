import { MANIFEST_OUTPUT_KEY } from '../wire/sourceMod';
import type { Manifest, ManifestFile, ManifestPackage } from '../manifestAdapter/manifestAdapter';

const upperUnit = (unit: string): string => {
  const upper = unit.toUpperCase();
  return upper.length === 1 ? upper : unit;
};
const upperUnits = (text: string): string => Array.from(text, upperUnit).join('');
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ordinalIgnoreCaseThenOrdinal = (a: string, b: string): number =>
  ordinal(upperUnits(a), upperUnits(b)) || ordinal(a, b);

const objectText = (members: readonly (readonly [string, string])[]): string =>
  `{${members.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;

const packageLine = (pkg: ManifestPackage, version: string | undefined): string => {
  const members: [string, string][] = [];
  if (pkg.kind === 'installationFile') {
    members.push(['installationFile', JSON.stringify(pkg.name)], ['size', JSON.stringify(pkg.size)], ['hash', JSON.stringify(pkg.hash)]);
    if (pkg.page !== undefined) members.push(['page', JSON.stringify(pkg.page)]);
  } else if (pkg.kind === 'gameFolder') {
    members.push(['gameFolder', JSON.stringify(pkg.name)], ['hash', JSON.stringify(pkg.hash)]);
    if (pkg.depots.length > 0) {
      members.push(['depots', objectText([...pkg.depots].sort((a, b) => ordinal(a.id, b.id)).map((depot) => [depot.id, JSON.stringify(depot.version)]))]);
    }
  } else {
    members.push([pkg.isSubmodule ? 'submodule' : 'repository', JSON.stringify(pkg.name)]);
  }
  if (version !== undefined) members.push(['version', JSON.stringify(version)]);
  return objectText(members);
};

const fileLine = (file: ManifestFile, first: string | undefined): object => {
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

export function manifestText(manifest: Manifest): string {
  const first = manifest.packages[0]?.name;
  const files = [...manifest.files].sort((a, b) => ordinalIgnoreCaseThenOrdinal(a.path, b.path));
  const members = [
    ...(manifest.output === undefined ? [] : [`"${MANIFEST_OUTPUT_KEY}": ${JSON.stringify(manifest.output)}`]),
    ...lineEach('packages', manifest.packages.map((pkg, index) => packageLine(pkg, index === 0 ? manifest.version : undefined))),
    ...(manifest.exclude.length === 0 ? [] : [`"exclude": ${JSON.stringify([...manifest.exclude].sort(ordinalIgnoreCaseThenOrdinal))}`]),
    ...(manifest.archives.length === 0
      ? []
      : [`"archives": {\n${manifest.archives.map((archive) => `${JSON.stringify(archive.path)}: ${JSON.stringify(archive.files)}`).join(',\n')}\n}`]),
    ...lineEach('steps', manifest.steps.map((step) => (step.args.length === 0 ? { task: step.task } : { task: step.task, args: step.args }))),
    ...lineEach('tools', manifest.tools),
    ...(files.length === 0 ? ['"files": []'] : lineEach('files', files.map((file) => fileLine(file, first)))),
  ];
  return `{\n${members.join(',\n')}\n}\n`;
}
