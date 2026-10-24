import { join } from 'node:path';
import type { FomodEngine } from '../instanceAdapter/fomodInstaller/fomodInstaller';

/** The engine as the development tree holds it: the engine's process from its source, and the add-on npm installed. */
export const FOMOD_ENGINE: FomodEngine = {
  process: join(__dirname, '..', 'instanceAdapter', 'fomodInstaller', 'engineProcess.ts'),
  folder: join(__dirname, '..', '..', 'node_modules', '@nexusmods', 'fomod-installer-native', 'prebuilds', `${process.platform}-${process.arch}`),
};
