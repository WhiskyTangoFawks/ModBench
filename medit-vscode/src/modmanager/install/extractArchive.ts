import { spawn } from 'node:child_process';

/** Runs a binary to completion; rejects with the spawn error (e.g. ENOENT when
 *  the binary is absent) or a non-zero-exit error. Injectable for testing. */
export type Runner = (bin: string, args: string[]) => Promise<void>;

const CANDIDATES = ['7z', '7za', '7zz'] as const;

const defaultRunner: Runner = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', reject); // ENOENT when the binary isn't on PATH
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)),
    );
  });

/** Extract a `.zip`/`.7z`/`.rar` archive into `destDir` via the system 7z binary.
 *  Tries the common 7-Zip binary names; if none is installed, throws an
 *  actionable error. A spawned-but-failed extraction (bad archive) throws too. */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  run: Runner = defaultRunner,
): Promise<void> {
  const args = ['x', archivePath, `-o${destDir}`, '-y'];
  for (const bin of CANDIDATES) {
    try {
      await run(bin, args);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // binary absent — try next name
      throw new Error(`Failed to extract ${archivePath}: ${(err as Error).message}`, { cause: err });
    }
  }
  throw new Error(
    `No 7z binary found (tried ${CANDIDATES.join(', ')}). ` +
      'Install p7zip-full to extract .zip/.7z/.rar archives.',
  );
}
