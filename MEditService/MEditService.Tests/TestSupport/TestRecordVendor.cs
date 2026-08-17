using MEditService.Core.Ledger;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// A real (never mocked, per ADR-0040/#370) <see cref="RecordVendor"/> for EditOrchestrator unit
/// tests that don't care about vendoring themselves — StageEdit's vendoring hook is best-effort and
/// logs rather than throws on failure, so a vendor pointed at an unused, never-cleaned-up temp root
/// is harmless noise for those tests, not a fake requiring its own maintenance. Tests that actually
/// assert on ledger state build their own <see cref="LedgerOptions"/> pointed at a real temp
/// directory instead (see the API-level vendoring tests).
/// </summary>
public static class TestRecordVendor
{
    public static RecordVendor Create() =>
        new(
            new LedgerRepository(
                new LedgerOptions(Path.Combine(Path.GetTempPath(), "medit-unit-test-ledgers")),
                NullLogger<LedgerRepository>.Instance),
            new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            NullLogger<RecordVendor>.Instance);
}
