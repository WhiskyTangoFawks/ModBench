import { describe, it, expect } from 'vitest';
import { settled } from '../../test/eventually';
import { fakeLogChannel, fakeMEdit, runningMEdit } from './fakeMEdit';

type Channel = ReturnType<typeof fakeLogChannel>;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const forwardedCount = (channel: Channel): number => LEVELS.reduce((count, level) => count + channel[level].mock.calls.length, 0);

async function forwarding() {
  const channel = fakeLogChannel();
  const { spawned } = await runningMEdit({ backendLog: channel });
  const [backend] = spawned;
  return {
    channel,
    write: (source: 'stdout' | 'stderr', line: string) => { backend?.[source].write(`${line}\n`); },
    forwarded: (count: number) => settled(() => { expect(forwardedCount(channel)).toBe(count); }),
  };
}

describe('the spawned backend\'s output, filed in the log channel', () => {
  it.each([
    ['DBG', 'debug'],
    ['INF', 'info'],
    ['WRN', 'warn'],
    ['ERR', 'error'],
    ['VRB', 'debug'],
    ['FTL', 'error'],
  ] as const)('routes a %s line to %s, stripping the tag', async (tag, level) => {
    const { channel, write, forwarded } = await forwarding();

    write('stdout', `[08:30:45 ${tag}] Indexed 500 records for Fallout4.esm`);
    await forwarded(1);

    expect(channel[level].mock.calls).toEqual([['[backend] Indexed 500 records for Fallout4.esm']]);
  });

  it('forwards an untagged first line at info, unchanged apart from the prefix', async () => {
    const { channel, write, forwarded } = await forwarding();

    write('stdout', 'Now listening on: http://localhost:5172');
    await forwarded(1);

    expect(channel.info).toHaveBeenCalledWith('[backend] Now listening on: http://localhost:5172');
  });

  it('keeps an untagged exception continuation at the level of the line it follows', async () => {
    const { channel, write, forwarded } = await forwarding();

    write('stdout', '[08:30:47 ERR] Reconcile failed');
    write('stdout', 'System.IO.FileNotFoundException: Could not find Broken.esp');
    write('stdout', '   at MEditService.RecordIndex.IndexProjector.Reconcile()');
    await forwarded(3);

    expect(channel.error).toHaveBeenCalledTimes(3);
    expect(channel.error).toHaveBeenLastCalledWith('[backend]    at MEditService.RecordIndex.IndexProjector.Reconcile()');
  });

  it('forwards an untagged stderr line at error — a .NET crash dump is not routine chatter', async () => {
    const { channel, write, forwarded } = await forwarding();

    write('stdout', '[08:30:45 INF] Now listening on: http://localhost:5172');
    write('stderr', 'Unhandled exception. System.InvalidOperationException: boom');
    await forwarded(2);

    expect(channel.error).toHaveBeenCalledWith('[backend] Unhandled exception. System.InvalidOperationException: boom');
  });

  it('tracks the carried level per stream, so a stdout continuation does not pick up stderr\'s error and a stderr continuation stays at error', async () => {
    const { channel, write, forwarded } = await forwarding();

    write('stdout', '[08:30:45 INF] Indexing');
    write('stderr', 'Unhandled exception. boom');
    write('stdout', 'continues the INF line');
    write('stderr', '   at Program.<Main>()');
    await forwarded(4);

    expect(channel.info).toHaveBeenLastCalledWith('[backend] continues the INF line');
    expect(channel.error).toHaveBeenLastCalledWith('[backend]    at Program.<Main>()');
  });

  it('drops whitespace-only lines', async () => {
    const { channel, write, forwarded } = await forwarding();

    write('stdout', '');
    write('stderr', '   ');
    write('stderr', 'the line after them');
    await forwarded(1);

    expect(channel.error.mock.calls).toEqual([['[backend] the line after them']]);
  });
});

describe('the level the backend is spawned at, the Output channel\'s vscode.LogLevel ordinal (Off=0, Trace=1, Debug=2, Info=3, Warning=4, Error=5) mapped to a Serilog minimum-level override for the spawn argv', () => {
  it.each([
    [0, []],
    [1, ['--Serilog:MinimumLevel:Default', 'Verbose']],
    [2, ['--Serilog:MinimumLevel:Default', 'Debug']],
    [3, ['--Serilog:MinimumLevel:Default', 'Information']],
    [4, ['--Serilog:MinimumLevel:Default', 'Warning']],
    [5, ['--Serilog:MinimumLevel:Default', 'Error']],
    [99, []],
  ])('maps channel level %i to %j', async (level, args) => {
    const mEdit = fakeMEdit({ backendLog: fakeLogChannel(level) });

    await mEdit.start();

    expect(mEdit.spawned[0]?.args).toEqual(['--urls', 'http://localhost:5172', ...args]);
  });
});
