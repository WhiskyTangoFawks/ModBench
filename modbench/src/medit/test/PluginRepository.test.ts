import { describe, it, expect, vi } from 'vitest';
import { ApiPluginRepository } from '../PluginRepository';
import type { ApiClient } from '../ApiClient';

// #368 Slice 3: ApiPluginRepository.getLedgerStatus maps the generated wire shape into the
// frontend's LedgerStatusEntry with the same default-coalescing convention every other repository
// method here already uses (toPluginMetadata, toRecordSummary, ...) — no VS Code, no backend.

function makeClient(opts: { entries?: unknown[]; ok?: boolean; status?: number }) {
  const { entries = [], ok = true, status = ok ? 200 : 500 } = opts;
  return {
    GET: vi.fn().mockImplementation(() =>
      Promise.resolve({
        data: ok ? entries : undefined,
        error: ok ? undefined : { message: 'boom' },
        response: { ok, status },
      })),
  } as unknown as ApiClient;
}

describe('ApiPluginRepository.getLedgerStatus', () => {
  it('maps a full wire entry through untouched', async () => {
    const client = makeClient({
      entries: [{
        plugin: 'Vendor.esp',
        origin: 'VendorMod',
        recordType: 'npc_',
        formKey: '000800:Vendor.esp',
        changeKind: 'Modified',
        recordPath: '/mods/VendorMod/Vendor.esp.ledger/npc_/Vendor.esp/000800.yaml',
        committedText: 'FormKey: 000800:Vendor.esp\n',
      }],
    });
    const repo = new ApiPluginRepository(client);

    const entries = await repo.getLedgerStatus();

    expect(entries).toEqual([{
      plugin: 'Vendor.esp',
      origin: 'VendorMod',
      recordType: 'npc_',
      formKey: '000800:Vendor.esp',
      changeKind: 'Modified',
      recordPath: '/mods/VendorMod/Vendor.esp.ledger/npc_/Vendor.esp/000800.yaml',
      committedText: 'FormKey: 000800:Vendor.esp\n',
    }]);
  });

  it('defaults absent/null fields the same way every other mapper here does', async () => {
    const client = makeClient({ entries: [{}] });
    const repo = new ApiPluginRepository(client);

    const entries = await repo.getLedgerStatus();

    expect(entries).toEqual([{
      plugin: '', origin: '', recordType: '', formKey: '',
      changeKind: 'Unknown', recordPath: '', committedText: '',
    }]);
  });

  it('returns an empty list rather than throwing when nothing is staged', async () => {
    const client = makeClient({ entries: [] });
    const repo = new ApiPluginRepository(client);

    expect(await repo.getLedgerStatus()).toEqual([]);
  });

  it('throws on a non-ok response, same ensureOk convention as every other read', async () => {
    const client = makeClient({ ok: false, status: 503 });
    const repo = new ApiPluginRepository(client);

    await expect(repo.getLedgerStatus()).rejects.toThrow(/getLedgerStatus failed \(503\)/);
  });
});
