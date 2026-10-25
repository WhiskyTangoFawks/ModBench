import { describe, it, expect, vi } from 'vitest';

import { backendLogLevelArgs, makeBackendLogForwarder } from '../backendLog';

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('makeBackendLogForwarder', () => {
  it.each([
    ['DBG', 'debug'],
    ['INF', 'info'],
    ['WRN', 'warn'],
    ['ERR', 'error'],
    ['VRB', 'debug'],
    ['FTL', 'error'],
  ] as const)('routes a %s line to %s, stripping the tag', (tag, level) => {
    const channel = fakeChannel();

    makeBackendLogForwarder(channel)(`[08:30:45 ${tag}] Indexed 500 records for Fallout4.esm`, 'stdout');

    expect(channel[level].mock.calls).toEqual([['[backend] Indexed 500 records for Fallout4.esm']]);
  });

  it('forwards an untagged first line at info, unchanged apart from the prefix', () => {
    const channel = fakeChannel();
    makeBackendLogForwarder(channel)('Now listening on: http://localhost:5172', 'stdout');

    expect(channel.info).toHaveBeenCalledWith('[backend] Now listening on: http://localhost:5172');
  });

  it('keeps an untagged exception continuation at the level of the line it follows', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('[08:30:47 ERR] Reconcile failed', 'stdout');
    forward('System.IO.FileNotFoundException: Could not find Broken.esp', 'stdout');
    forward('   at MEditService.RecordIndex.IndexProjector.Reconcile()', 'stdout');

    expect(channel.error).toHaveBeenCalledTimes(3);
    expect(channel.error).toHaveBeenLastCalledWith('[backend]    at MEditService.RecordIndex.IndexProjector.Reconcile()');
    expect(channel.info).not.toHaveBeenCalled();
  });

  it('forwards an untagged stderr line at error — a .NET crash dump is not routine chatter', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('[08:30:45 INF] Now listening on: http://localhost:5172', 'stdout');
    forward('Unhandled exception. System.InvalidOperationException: boom', 'stderr');

    expect(channel.error).toHaveBeenCalledWith('[backend] Unhandled exception. System.InvalidOperationException: boom');
  });

  it('tracks the carried level per stream, so a stdout continuation does not pick up stderr\'s error and a stderr continuation stays at error', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('[08:30:45 INF] Indexing', 'stdout');
    forward('Unhandled exception. boom', 'stderr');
    forward('continues the INF line', 'stdout');
    forward('   at Program.<Main>()', 'stderr');

    expect(channel.info).toHaveBeenLastCalledWith('[backend] continues the INF line');
    expect(channel.error).toHaveBeenLastCalledWith('[backend]    at Program.<Main>()');
  });

  it('drops whitespace-only lines', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('', 'stdout');
    forward('   ', 'stderr');

    expect(channel.debug).not.toHaveBeenCalled();
    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });
});

describe('backendLogLevelArgs, mapping the Output channel\'s vscode.LogLevel ordinal (Off=0, Trace=1, Debug=2, Info=3, Warning=4, Error=5) to a Serilog minimum-level override for the spawn argv', () => {
  it.each([
    [0, []],
    [1, ['--Serilog:MinimumLevel:Default', 'Verbose']],
    [2, ['--Serilog:MinimumLevel:Default', 'Debug']],
    [3, ['--Serilog:MinimumLevel:Default', 'Information']],
    [4, ['--Serilog:MinimumLevel:Default', 'Warning']],
    [5, ['--Serilog:MinimumLevel:Default', 'Error']],
    [99, []],
  ])('maps channel level %i to %j', (level, args) => {
    expect(backendLogLevelArgs(level)).toEqual(args);
  });
});
