using MEditService.Core.Ledger;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #368 review (mutation axis, optional item): <see cref="LedgerRepository.WorkingTreeStatus"/>'s
/// crash-recovery fallback — reading the index status column when the working-tree column is blank
/// — had no direct coverage. Real git throughout, cheap to construct with the same primitives every
/// other Ledger/ test already uses.
/// </summary>
public sealed class LedgerRepositoryWorkingTreeStatusTests
{
    [Fact]
    public void StagedButUncommittedEdit_FallsBackToTheIndexStatusColumn()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-repo-status-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-origin-staged-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
            var absolutePath = Path.Combine(originFolder, relativePath);

            ledger.EnsureRepo(originFolder);
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
            File.WriteAllText(absolutePath, "FormKey: 000800:Vendor.esp\n");
            ledger.StagePath(originFolder, relativePath);
            ledger.CommitStaged(originFolder, "vendor: test fixture");

            // Edit, then stage the edit — and stop there. The working tree now matches the index
            // exactly (nothing further to show in the worktree column), but the index still differs
            // from HEAD (the baseline commit above) — the exact "stray staged entry" shape
            // LedgerRepository's own class remarks describe as the crash-recovery case
            // ResetIndexToHead exists to clean up, caught here mid-flight instead of after a crash.
            File.WriteAllText(absolutePath, "FormKey: 000800:Vendor.esp\nAggression: Frenzied\n");
            ledger.StagePath(originFolder, relativePath);

            var status = ledger.WorkingTreeStatus(originFolder);

            var (code, path) = Assert.Single(status);
            Assert.Equal('M', code);
            Assert.Equal(relativePath, path);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
