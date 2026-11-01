import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadedFileReader } from '../downloadedFileReader';

describe('downloadedFileReader, spawning the binary itself', () => {
  const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);
  const FAKE_7Z = exe('7z');
  let bin: string;
  let originalPath: string | undefined;
  let originalNodeOptions: string | undefined;
  const argvFile = () => join(bin, 'argv.json');

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'fake-7z-'));
    await copyFile(process.execPath, join(bin, FAKE_7Z));
    await writeFile(join(bin, 'exit-as-asked.cjs'), 'require("fs").writeFileSync(process.env.FAKE_7Z_ARGV_FILE, JSON.stringify([require("path").basename(process.argv[1]), ...process.argv.slice(2)])); process.stdout.write(process.env.FAKE_7Z_STDOUT ?? ""); process.stderr.write(process.env.FAKE_7Z_STDERR ?? ""); if (process.env.FAKE_7Z_BIN_FILE) require("fs").writeFileSync(process.env.FAKE_7Z_BIN_FILE, require("path").basename(process.execPath)); if (process.env.FAKE_7Z_SIGNAL) process.kill(process.pid, process.env.FAKE_7Z_SIGNAL); else process.exit(Number(process.env.FAKE_7Z_EXIT));');
  });
  afterAll(() => rm(bin, { recursive: true, force: true }));
  beforeEach(async () => {
    await rm(argvFile(), { force: true });
    originalPath = process.env.PATH;
    originalNodeOptions = process.env.NODE_OPTIONS;
    process.env.PATH = bin;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    delete process.env.FAKE_7Z_EXIT;
    delete process.env.FAKE_7Z_STDOUT;
    delete process.env.FAKE_7Z_STDERR;
    delete process.env.FAKE_7Z_ARGV_FILE;
    delete process.env.FAKE_7Z_SIGNAL;
    delete process.env.FAKE_7Z_BIN_FILE;
  });

  const argvAsked = async (): Promise<unknown> => JSON.parse(await readFile(argvFile(), 'utf8'));

  const fakeNodeAs7zPreloadedToExit = (code: number) => {
    process.env.FAKE_7Z_ARGV_FILE = argvFile();
    process.env.FAKE_7Z_EXIT = String(code);
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(join(bin, 'exit-as-asked.cjs'))}`;
  };

  const fakeNodeAs7zPreloadedToDieBy = (signal: NodeJS.Signals) => {
    fakeNodeAs7zPreloadedToExit(0);
    process.env.FAKE_7Z_SIGNAL = signal;
  };

  it('extracts into the destination, overwriting, by asking 7z for exactly that', async () => {
    fakeNodeAs7zPreloadedToExit(0);

    await downloadedFileReader.extract('/tmp/mod.7z', '/tmp/stage');

    expect(await argvAsked()).toEqual(['x', '/tmp/mod.7z', '-o/tmp/stage', '-y']);
  });

  it('rejects with the exit code in the message when the binary exits non-zero', async () => {
    fakeNodeAs7zPreloadedToExit(3);

    await expect(downloadedFileReader.extract('/tmp/mod.7z', '/tmp/stage')).rejects.toThrow(/exited with code 3/);
  });

  it.skipIf(process.platform === 'win32')('(Windows has no signals) names the signal that killed the binary', async () => {
    fakeNodeAs7zPreloadedToDieBy('SIGSEGV');

    await expect(downloadedFileReader.extract('/tmp/mod.rar', '/tmp/stage')).rejects.toThrow('Failed to extract /tmp/mod.rar: 7z was killed by signal SIGSEGV');
  });

  it('names every candidate, and the archives install extracts, when no binary is on the path', async () => {
    process.env.PATH = '';

    await expect(downloadedFileReader.extract('/tmp/mod.7z', '/tmp/stage')).rejects.toThrow(
      'No 7z binary found (tried 7zz, 7z, 7za). Install 7-Zip to extract .zip/.7z/.rar archives.');
  });

  it('lists the file entries, leaving out directories', async () => {
    fakeNodeAs7zPreloadedToExit(0);
    process.env.FAKE_7Z_STDOUT = [
      'Path = Wrapper\nAttributes = D drwxr-xr-x',
      'Path = Wrapper/locked\nAttributes = RD dr-xr-xr-x',
      'Path = Wrapper\\textures\\a.dds\nAttributes = A -rw-r--r--',
      'Path = Wrapper/b.esp\nAttributes = A',
    ].join('\n\n') + '\n';

    await expect(downloadedFileReader.list('/tmp/mod.7z')).resolves.toEqual(['Wrapper/textures/a.dds', 'Wrapper/b.esp']);
  });

  it('reads non-ASCII entry names as UTF-8 and asks 7z to write them so', async () => {
    fakeNodeAs7zPreloadedToExit(0);
    process.env.FAKE_7Z_STDOUT = 'Path = café/日本.esp\nAttributes = A\n';

    await expect(downloadedFileReader.list('/tmp/mod.7z')).resolves.toEqual(['café/日本.esp']);

    expect(await argvAsked()).toEqual(['l', '-slt', '-ba', '-sccUTF-8', '/tmp/mod.7z']);
  });

  it.each([
    ['carries 7z\'s stderr, trimmed, as why', 'ERROR: /tmp/bad.7z : opening : errno=13 : Permission denied\n', /Failed to list \/tmp\/bad\.7z: ERROR: .*Permission denied$/],
    ['keeps the exit code when 7z writes nothing to stderr', '', /Failed to list \/tmp\/bad\.7z: .*exited with code 2$/],
  ])('rejects a listing that %s', async (_name, stderr, message) => {
    fakeNodeAs7zPreloadedToExit(2);
    process.env.FAKE_7Z_STDERR = stderr;

    await expect(downloadedFileReader.list('/tmp/bad.7z')).rejects.toThrow(message);
  });

  it('asks 7zz, the 7-Zip that reads RAR with no codec plugin, before 7z', async () => {
    const also7zz = join(bin, exe('7zz'));
    await copyFile(process.execPath, also7zz);
    fakeNodeAs7zPreloadedToExit(0);
    process.env.FAKE_7Z_BIN_FILE = join(bin, 'bin.txt');

    try {
      await downloadedFileReader.extract('/tmp/mod.rar', '/tmp/stage');

      expect(await readFile(process.env.FAKE_7Z_BIN_FILE, 'utf8')).toBe(exe('7zz'));
    } finally {
      await rm(also7zz, { force: true });
    }
  });

  it('falls through to the next binary name when one is absent', async () => {
    const only7za = join(bin, exe('7za'));
    await rename(join(bin, FAKE_7Z), only7za);
    fakeNodeAs7zPreloadedToExit(0);

    try {
      await downloadedFileReader.extract('/tmp/mod.7z', '/tmp/stage');

      expect(await argvAsked()).toEqual(['x', '/tmp/mod.7z', '-o/tmp/stage', '-y']);
    } finally {
      await rename(only7za, join(bin, FAKE_7Z));
    }
  });
});
