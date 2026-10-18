import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|third-party-notices|notice)/i;

function licenseTexts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => readFileSync(join(dir, entry.name), 'utf8').trim());
}

function npmPackages() {
  const found = new Map();
  const visit = (name, fromDir, optional = false) => {
    for (let dir = fromDir; ; dir = join(dir, '..')) {
      const manifestPath = join(dir, 'node_modules', name, 'package.json');
      if (!existsSync(manifestPath)) {
        if (dir !== join(dir, '..')) continue;
        if (optional) return;
        throw new Error(`${name} is a dependency of ${fromDir} and is not installed`);
      }
      const packageDir = join(dir, 'node_modules', name);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const id = `${manifest.name}@${manifest.version}`;
      if (found.has(id)) return;
      found.set(id, { id, license: manifest.license, texts: licenseTexts(packageDir) });
      for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, packageDir);
      for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dependency, packageDir, true);
      return;
    }
  };
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const dependency of Object.keys(root.dependencies)) visit(dependency, process.cwd());
  return [...found.values()];
}

function nugetPackages() {
  const cache = process.env.NUGET_PACKAGES ?? join(homedir(), '.nuget', 'packages');
  const deps = JSON.parse(readFileSync('backend/MEditService.Http.deps.json', 'utf8'));
  return Object.entries(deps.libraries)
    .filter(([, library]) => library.type === 'package' || library.type === 'runtimepack')
    .map(([key]) => {
      const [rawName, version] = key.split('/');
      const name = rawName.replace(/^runtimepack\./, '');
      const dir = join(cache, name.toLowerCase(), version);
      const nuspec = readFileSync(join(dir, `${name.toLowerCase()}.nuspec`), 'utf8');
      const license = /<license [^>]*>([^<]+)<\/license>/.exec(nuspec)?.[1] ?? /<licenseUrl>([^<]+)<\/licenseUrl>/.exec(nuspec)?.[1];
      return { id: `${name}@${version}`, license, texts: licenseTexts(dir) };
    });
}

const sections = [...npmPackages(), ...nugetPackages()]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map(({ id, license, texts }) => [`${id} (${license ?? 'license not declared'})`, ...texts].join('\n\n'));

writeFileSync('THIRD-PARTY-NOTICES.txt', `Modbench bundles the following third-party software.\n\n${sections.join('\n\n----------------------------------------\n\n')}\n`);
