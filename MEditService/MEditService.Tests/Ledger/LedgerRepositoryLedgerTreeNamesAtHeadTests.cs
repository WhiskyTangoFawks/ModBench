using MEditService.Core.Ledger;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #392: <see cref="LedgerRepository.LedgerTreeNamesAtHead"/> — what a lifecycle-reconciliation
/// pass needs to know which plugins this origin's repo currently has a ledger tree for, read from
/// git history rather than the working tree (an orphaned or removed plugin has no working-tree
/// ledger dir left to walk, only the commit recording it once existed). Real git throughout, same
/// pattern as <see cref="LedgerRepositoryWorkingTreeStatusTests"/>.
/// </summary>
public sealed class LedgerRepositoryLedgerTreeNamesAtHeadTests
{
    [Fact]
    public void CommittedLedgerTree_ReturnsItsTopLevelDirName()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-treenames-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-origin-treenames-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var relativePath = LedgerRecordPath.For("MyMod.esp", "npc_", "000800:MyMod.esp");
            var absolutePath = Path.Combine(originFolder, relativePath);

            ledger.EnsureRepo(originFolder);
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
            File.WriteAllText(absolutePath, "FormKey: 000800:MyMod.esp\n");
            ledger.StagePath(originFolder, relativePath);
            ledger.CommitStaged(originFolder, "vendor: test fixture");

            var names = ledger.LedgerTreeNamesAtHead(originFolder);

            Assert.Equal(["MyMod.esp.ledger"], names);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    [Fact]
    public void NoRepo_ReturnsEmpty()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-treenames-norepo-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-origin-treenames-norepo-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);

            var names = ledger.LedgerTreeNamesAtHead(originFolder);

            Assert.Empty(names);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // EnsureRepo without ever staging/committing leaves an unborn HEAD (a real, if unusual, state
    // this method must not throw on — RepoExists is gated on the gitdir's own HEAD file existing,
    // not on there being a commit).
    [Fact]
    public void RepoExistsButNothingCommittedYet_ReturnsEmpty()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-treenames-unborn-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-origin-treenames-unborn-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(originFolder);

            var names = ledger.LedgerTreeNamesAtHead(originFolder);

            Assert.Empty(names);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
