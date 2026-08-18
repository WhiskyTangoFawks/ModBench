using MEditService.Core.Ledger;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
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

    // Mutation-testing finding (#372 review): ReadJournals' own doc states a non-GUID-named file is
    // skipped, but nothing exercised a stray one actually sitting alongside a real journal — a
    // mutant removing that guard survived.
    [Fact]
    public void ReadJournals_StrayNonGuidNamedFileInTheJournalDirectory_IsSkipped()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        try
        {
            var ledger = MakeLedger(ledgerRoot);
            var groupId = Guid.NewGuid();
            ledger.WriteJournal(groupId, [new LedgerRepository.JournalEntry("/some/origin", "dddddddddddddddddddddddddddddddddddddddd", "save: npc_ one")]);

            // A file this class never wrote — not a bare GUID name — sitting in the same directory.
            var journalDirectory = Path.Combine(ledgerRoot, "_journal");
            File.WriteAllText(Path.Combine(journalDirectory, "not-a-guid.json"), "[]");

            var journal = Assert.Single(ledger.ReadJournals());
            Assert.Equal(groupId, journal.GroupId);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }

    // Mutation-testing finding (#372 review): a journal file whose content is the valid JSON
    // literal `null` (as opposed to malformed JSON, already covered by the JsonException catch)
    // deserializes to a null list — the `?? []` guard against that had nothing asserting it,
    // so a mutant removing it (an NRE waiting to happen the moment a caller enumerates Entries)
    // survived.
    [Fact]
    public void ReadJournals_FileContentIsJsonNull_TreatedAsEmptyEntries_NotThrown()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        try
        {
            var ledger = MakeLedger(ledgerRoot);
            var groupId = Guid.NewGuid();
            var journalDirectory = Path.Combine(ledgerRoot, "_journal");
            Directory.CreateDirectory(journalDirectory);
            File.WriteAllText(Path.Combine(journalDirectory, $"{groupId:N}.json"), "null");

            var journal = Assert.Single(ledger.ReadJournals());

            Assert.Equal(groupId, journal.GroupId);
            Assert.Empty(journal.Entries);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }

    // Mutation-testing finding (#372 review): a journal entry naming an origin whose repo was
    // never even created — the earliest possible crash point, before EnsureRepo ever ran — must
    // refuse loudly and fabricate nothing, not silently create a fresh repo just to satisfy it.
    [Fact]
    public void Recover_JournalEntryForOriginWithNoRepoAtAll_RefusesLoudly_CreatesNothing()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-journal-origin-").FullName;
        try
        {
            var entries = new List<LogEntry>();
            var loggerFactory = LoggerFactory.Create(b =>
            {
                b.SetMinimumLevel(LogLevel.Debug);
                b.AddProvider(new CollectingLoggerProvider(entries));
            });
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), loggerFactory.CreateLogger<LedgerRepository>());
            var groupId = Guid.NewGuid();
            var entry = new LedgerRepository.JournalEntry(
                Path.GetFullPath(originFolder), "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "save: npc_ one");
            ledger.WriteJournal(groupId, [entry]);

            ledger.Recover();

            var (gitDir, _) = ledger.PathsFor(originFolder);
            Assert.False(Directory.Exists(gitDir));

            var journal = Assert.Single(ledger.ReadJournals());
            Assert.Equal(entry, Assert.Single(journal.Entries));

            // The specific "no repo at all" message, not just any Error mentioning the folder —
            // a mutant that deletes this branch's own early return still logs *an* Error (the
            // outer per-entry catch, wrapping the git failure that follows from treating a
            // nonexistent gitdir as if it existed), so only the exact wording discriminates.
            Assert.Contains(entries, e =>
                e.Level == LogLevel.Error &&
                e.Message.Contains("has no repo at all", StringComparison.Ordinal) &&
                e.Message.Contains(Path.GetFullPath(originFolder), StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
