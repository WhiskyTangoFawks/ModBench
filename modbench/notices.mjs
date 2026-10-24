import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LICENSE_TEXTS = 'notice-licenses';
const LICENSE_FILE = /^(licen[cs]e|third-party-notices|notice)/i;

function licenseTexts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => LICENSE_FILE.test(entry.name))
    .flatMap((entry) => (entry.isDirectory() ? licenseTexts(join(dir, entry.name)) : [readFileSync(join(dir, entry.name), 'utf8').trim()]));
}

function suppliedTexts() {
  const sources = JSON.parse(readFileSync(join(LICENSE_TEXTS, 'sources.json'), 'utf8'));
  const byId = new Map();
  for (const [file, { packages }] of Object.entries(sources)) {
    const text = readFileSync(join(LICENSE_TEXTS, file), 'utf8').trim();
    for (const [name, version] of Object.entries(packages)) byId.set(`${name}@${version}`, text);
  }
  return byId;
}

function npmPackages(supplied) {
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
      const shipped = licenseTexts(packageDir);
      found.set(id, { id, license: manifest.license, texts: shipped.length > 0 ? shipped : [supplied.get(id)].filter(Boolean) });
      for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, packageDir);
      for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dependency, packageDir, true);
      return;
    }
  };
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const dependency of Object.keys(root.dependencies)) visit(dependency, process.cwd());
  return [...found.values()];
}

function nugetPackages(supplied) {
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
      const id = `${name}@${version}`;
      const shipped = licenseTexts(dir);
      return { id, license, texts: shipped.length > 0 ? shipped : [supplied.get(id)].filter(Boolean) };
    });
}

const supplied = suppliedTexts();
const packages = [...npmPackages(supplied), ...nugetPackages(supplied)].sort((a, b) => a.id.localeCompare(b.id));
const textless = packages.filter(({ texts }) => texts.length === 0).map(({ id }) => id);
if (textless.length > 0) {
  throw new Error(`No license text for ${textless.join(', ')}. A package that ships none takes its text from ${LICENSE_TEXTS}/sources.json: recheck the license at the new version and key its entry to that version.`);
}
const sections = packages.map(({ id, license, texts }) => [`${id} (${license ?? 'see license text'})`, ...texts].join('\n\n'));

writeFileSync('THIRD-PARTY-NOTICES.txt', `Modbench bundles the following third-party software.\n\n${sections.join('\n\n----------------------------------------\n\n')}\n`.replaceAll('\r\n', '\n'));
