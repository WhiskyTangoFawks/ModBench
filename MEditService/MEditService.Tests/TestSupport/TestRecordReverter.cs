using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// A real (never mocked) <see cref="RecordReverter"/> for EditOrchestrator unit tests that don't
/// exercise revert themselves — mirrors <see cref="TestRecordVendor"/>'s own rationale: a reverter
/// pointed at an unused, never-cleaned-up temp ledger root is harmless noise for those tests, not a
/// fake requiring its own maintenance. Tests that actually assert on revert behaviour build their
/// own <see cref="LedgerOptions"/> pointed at a real temp directory instead (see the API-level
/// ledger-commit tests).
/// </summary>
public static class TestRecordReverter
{
    public static RecordReverter Create()
    {
        var reflector = SharedSchemaReflector.Instance;
        var repositoryFactory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new RecordReverter(
            new LedgerRepository(
                new LedgerOptions(Path.Combine(Path.GetTempPath(), "medit-unit-test-ledgers")),
                NullLogger<LedgerRepository>.Instance),
            new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            new LedgerRecordFieldReader(repositoryFactory));
    }
}
