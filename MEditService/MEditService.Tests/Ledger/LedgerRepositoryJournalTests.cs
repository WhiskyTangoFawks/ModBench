using MEditService.Core.Ledger;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #372 slice 1/2: the two journal primitives <see cref="LedgerGroupCommitter"/>'s prepare/advance
/// split is built on — <see cref="LedgerRepository.WriteTree"/> (the "expected content hash" the
/// journal records) and the journal file round-trip itself
/// (<see cref="LedgerRepository.WriteJournal"/>/<see cref="LedgerRepository.ReadJournals"/>/
/// <see cref="LedgerRepository.DeleteJournal"/>). Real git, real filesystem — same seam choice as
/// every other <c>Ledger/</c> test.
/// </summary>
public sealed class LedgerRepositoryJournalTests
{
    private static LedgerRepository MakeLedger(string ledgerRoot) =>
        new(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);

    [Fact]
    public void WriteTree_ReflectsCurrentlyStagedContent_NotWhatWasLastCommitted()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-journal-origin-").FullName;
        try
        {
            var ledger = MakeLedger(ledgerRoot);
            var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
            var absolutePath = Path.Combine(originFolder, relativePath);

            ledger.EnsureRepo(originFolder);
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
            File.WriteAllText(absolutePath, "FormKey: 000800:Vendor.esp\n");
            ledger.StagePath(originFolder, relativePath);
            var treeBeforeCommit = ledger.WriteTree(originFolder);
            ledger.CommitStaged(originFolder, "vendor: test fixture");

            // The tree write-tree reports for a staged-but-uncommitted state matches what git
            // itself recorded as HEAD's tree once that exact state was committed — an independent
            // check via `git show -s --format=%T`, not a recomputation via this class's own method.
            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var headTree = GitCli.Run(gitDir, workTree, "show", "-s", "--format=%T", "HEAD").Trim();
            Assert.Equal(headTree, treeBeforeCommit);

            // Staging a further edit changes the reported tree again.
            File.WriteAllText(absolutePath, "FormKey: 000800:Vendor.esp\nAggression: Frenzied\n");
            ledger.StagePath(originFolder, relativePath);
            var treeAfterSecondEdit = ledger.WriteTree(originFolder);
            Assert.NotEqual(treeBeforeCommit, treeAfterSecondEdit);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    [Fact]
    public void WriteJournal_ThenReadJournals_RoundTripsEveryEntry()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        try
        {
            var ledger = MakeLedger(ledgerRoot);
            var groupId = Guid.NewGuid();
            var entries = new List<LedgerRepository.JournalEntry>
            {
                new("/some/origin/one", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "save: npc_ one"),
                new("/some/origin/two", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "save: npc_ two"),
            };

            ledger.WriteJournal(groupId, entries);

            var journals = ledger.ReadJournals();
            var journal = Assert.Single(journals, j => j.GroupId == groupId);
            Assert.Equal(entries, journal.Entries);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }

    [Fact]
    public void DeleteJournal_RemovesTheFile_ReadJournalsNoLongerReportsIt()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        try
        {
            var ledger = MakeLedger(ledgerRoot);
            var groupId = Guid.NewGuid();
            ledger.WriteJournal(groupId, [new LedgerRepository.JournalEntry("/some/origin", "cccccccccccccccccccccccccccccccccccccccc", "save: npc_ one")]);

            ledger.DeleteJournal(groupId);

            Assert.Empty(ledger.ReadJournals());
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }
}
