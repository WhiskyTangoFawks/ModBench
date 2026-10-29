import { spawn } from 'node:child_process';
import { errnoCode } from '../../ports/errno';
import { INSTALLATION_FILE_EXTENSIONS } from './installationFileNames';
import { errorMessage } from '../../ports/errorMessage';
import type { InstallationFileReader } from './installationFileReader';

const CANDIDATES = ['7z', '7za', '7zz'] as const;

function spawnCollecting(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const why = Buffer.concat(err).toString('utf8').trim();
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(why === '' ? `${bin} exited with code ${code}` : why));
    });
  });
}

async function stdoutOfSevenZip(installationFilePath: string, verb: string, args: string[]): Promise<string> {
  for (const bin of CANDIDATES) {
    try {
      return await spawnCollecting(bin, args);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue;
      throw new Error(`Failed to ${verb} ${installationFilePath}: ${errorMessage(err)}`);
    }
  }
  const extensions = INSTALLATION_FILE_EXTENSIONS.map((ext) => `.${ext}`).join('/');
  throw new Error(
    `No 7z binary found (tried ${CANDIDATES.join(', ')}). ` +
      `Install p7zip-full to extract ${extensions} archives.`,
  );
}

function fileEntries(listing: string): string[] {
  return listing.split(/\r?\n\r?\n/).flatMap((block) => {
    const field = (name: string): string | undefined => new RegExp(`^${name} = (.*)$`, 'm').exec(block)?.[1];
    const path = field('Path');
    return path === undefined || (field('Attributes') ?? '').split(' ')[0]?.includes('D') ? [] : [path.replaceAll('\\', '/')];
  });
}

export const downloadedFileReader: InstallationFileReader = {
  list: async (installationFilePath) => fileEntries(await stdoutOfSevenZip(installationFilePath, 'list', ['l', '-slt', '-ba', '-sccUTF-8', installationFilePath])),
  extract: async (installationFilePath, destDir) => {
    await stdoutOfSevenZip(installationFilePath, 'extract', ['x', installationFilePath, `-o${destDir}`, '-y']);
  },
};
