import { describe, it, expect, vi } from 'vitest';

import { makeBackendLogForwarder } from '../backendLog';

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('makeBackendLogForwarder', () => {
  it('routes each Serilog level tag to the matching leveled call, stripping the tag', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('[08:30:45 DBG] Extracted column Name');
    forward('[08:30:45 INF] Indexed 500 records for Fallout4.esm');
    forward('[08:30:46 WRN] Skipped plugin Broken.esp');
    forward('[08:30:47 ERR] Session load failed');

    expect(channel.debug).toHaveBeenCalledWith('[backend] Extracted column Name');
    expect(channel.info).toHaveBeenCalledWith('[backend] Indexed 500 records for Fallout4.esm');
    expect(channel.warn).toHaveBeenCalledWith('[backend] Skipped plugin Broken.esp');
    expect(channel.error).toHaveBeenCalledWith('[backend] Session load failed');
  });

  it('treats VRB as debug and FTL as error', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('[08:30:45 VRB] chatty');
    forward('[08:30:45 FTL] unrecoverable');

    expect(channel.debug).toHaveBeenCalledWith('[backend] chatty');
    expect(channel.error).toHaveBeenCalledWith('[backend] unrecoverable');
  });

  it('forwards an untagged first line at info, unchanged apart from the prefix', () => {
    const channel = fakeChannel();
    makeBackendLogForwarder(channel)('Now listening on: http://localhost:5172');

    expect(channel.info).toHaveBeenCalledWith('[backend] Now listening on: http://localhost:5172');
  });

  it('keeps an untagged exception continuation at the level of the line it follows', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('[08:30:47 ERR] Session load failed');
    forward('System.IO.FileNotFoundException: Could not find Broken.esp');
    forward('   at MEditService.Core.Session.SessionManager.Load()');

    expect(channel.error).toHaveBeenCalledTimes(3);
    expect(channel.error).toHaveBeenLastCalledWith('[backend]    at MEditService.Core.Session.SessionManager.Load()');
    expect(channel.info).not.toHaveBeenCalled();
  });

  it('drops whitespace-only lines', () => {
    const channel = fakeChannel();
    const forward = makeBackendLogForwarder(channel);

    forward('');
    forward('   ');

    expect(channel.debug).not.toHaveBeenCalled();
    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });
});
