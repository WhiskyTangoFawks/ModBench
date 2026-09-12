import { spawn } from 'node:child_process';
import { errnoCode } from '../../errno';

/** Rejects with the spawn error (ENOENT when the binary is absent) or a
 *  non-zero-exit error; `extractArchive` distinguishes the two. */
export type Runner = (bin: string, args: string[]) => Promise<void>;

const CANDIDATES = ['7z', '7za', '7zz'] as const;

// Exported only as a test seam: any real executable exercises the resolve/reject
// wiring without a 7z binary or archive fixture.
export const defaultRunner: Runner = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', reject); // ENOENT when the binary isn't on PATH
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)),
    );
  });

/** Extracts via whichever system 7-Zip binary name exists; a missing binary and a
 *  bad archive both throw, with different messages. */
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
      if (errnoCode(err) === 'ENOENT') continue; // binary absent — try next name
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to extract ${archivePath}: ${message}`, { cause: err });
    }
  }
  throw new Error(
    `No 7z binary found (tried ${CANDIDATES.join(', ')}). ` +
      'Install p7zip-full to extract .zip/.7z/.rar archives.',
  );
}
