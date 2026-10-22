import { createNexus, type Nexus, type SecretStore } from './nexus';

function versionOf(packageJson: unknown): string {
  return typeof packageJson === 'object' && packageJson !== null && 'version' in packageJson && typeof packageJson.version === 'string'
    ? packageJson.version : 'unknown';
}

export function createHttpNexus(secrets: SecretStore, extensionPackage: unknown): Nexus {
  return createNexus({ secrets, applicationVersion: versionOf(extensionPackage), fetch });
}
