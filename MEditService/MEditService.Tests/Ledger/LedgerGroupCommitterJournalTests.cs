using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #372: cross-repo atomicity — <see cref="LedgerGroupCommitter"/>'s prepare/journal/advance split
/// and <see cref="LedgerRepository.Recover"/>'s replay of whatever a prior process left behind. Real
/// git throughout (no HTTP, no mocked git), same seam choice as
/// <see cref="LedgerGroupCommitterTests"/>. Crash injection follows that same suite's existing
/// idiom — internal primitives reached via <c>InternalsVisibleTo</c>, not a real process kill:
/// <see cref="LedgerGroupCommitter.PrepareAsync"/> stages and journals for real, then a test drives
/// <see cref="LedgerGroupCommitter.AdvanceOneAsync"/> for only a subset of the prepared origins,
/// leaving the rest exactly as a genuine crash between two Advance iterations would — never
/// disposed, never committed, staged content still sitting in the index on disk — before a *fresh*
/// <see cref="LedgerRepository"/> instance (standing in for a restarted process) calls
/// <see cref="LedgerRepository.Recover"/>.
/// </summary>
public sealed class LedgerGroupCommitterJournalTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static (RecordVendor Vendor, LedgerGroupCommitter Committer, LedgerRepository Ledger) MakeCollaborators(string ledgerRoot) =>
        MakeCollaborators(ledgerRoot, NullLogger<LedgerRepository>.Instance, NullLogger<LedgerGroupCommitter>.Instance);

    private static (RecordVendor Vendor, LedgerGroupCommitter Committer, LedgerRepository Ledger) MakeCollaborators(
        string ledgerRoot, ILogger<LedgerRepository> ledgerLogger, ILogger<LedgerGroupCommitter> committerLogger)
    {
        var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), ledgerLogger);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var vendor = new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance);
        var committer = new LedgerGroupCommitter(ledger, codec, SharedSchemaReflector.Instance, committerLogger);
        return (vendor, committer, ledger);
    }

    private static string WritePlugin(string originFolder, string pluginFileName, out string npcFormKey)
    {
        var pluginPath = Path.Combine(originFolder, pluginFileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginFileName), Fallout4Release.Fallout4);
        npcFormKey = mod.Npcs.AddNew("CommitterNpc").FormKey.ToString();
        mod.WriteToBinary(pluginPath);
        return pluginPath;
    }

    private static async Task VendorAsync(RecordVendor vendor, string originFolder, string pluginPath, string pluginFileName, string formKey)
    {
        await vendor.VendorAndStageDirtAsync(
            originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
            new Dictionary<string, JsonElement> { ["aggression"] = JsonDocument.Parse("\"Frenzied\"").RootElement.Clone() },
            Schemas, GameRelease.Fallout4);
    }

    private static int CommitCount(LedgerRepository ledger, string originFolder)
    {
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        if (!Directory.Exists(gitDir)) return 0;
        return GitCli.TryRun(gitDir, workTree, out var log, "log", "--oneline", "main")
            ? log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length
            : 0;
    }

    private static (LedgerRepository, List<LogEntry>) FreshLedgerWithLog(string ledgerRoot)
    {
        var entries = new List<LogEntry>();
        var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (new LedgerRepository(new LedgerOptions(ledgerRoot), loggerFactory.CreateLogger<LedgerRepository>()), entries);
    }

    // AC1/slice 4: on an ordinary, uninterrupted multi-origin save, the journal this group wrote
    // during Prepare is gone again once Advance finishes — nothing left on disk for Recover to
    // ever have to look at.
    [Fact]
    public async Task CommitGroupSave_RecordsAcrossTwoOrigins_LeavesNoJournalBehindOnSuccess()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var origin1 = Directory.CreateTempSubdirectory("medit-journal-origin1-").FullName;
        var origin2 = Directory.CreateTempSubdirectory("medit-journal-origin2-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            var plugin1Path = WritePlugin(origin1, "Origin1.esp", out var npc1FormKey);
            var plugin2Path = WritePlugin(origin2, "Origin2.esp", out var npc2FormKey);
            await VendorAsync(vendor, origin1, plugin1Path, "Origin1.esp", npc1FormKey);
            await VendorAsync(vendor, origin2, plugin2Path, "Origin2.esp", npc2FormKey);

            await committer.CommitGroupSaveAsync([
                new LedgerTouchedRecord(origin1, "Origin1.esp", "npc_", npc1FormKey),
                new LedgerTouchedRecord(origin2, "Origin2.esp", "npc_", npc2FormKey),
            ], GameRelease.Fallout4);

            Assert.Equal(2, CommitCount(ledger, origin1));
            Assert.Equal(2, CommitCount(ledger, origin2));
            Assert.Empty(ledger.ReadJournals());
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(origin1, recursive: true);
            Directory.Delete(origin2, recursive: true);
        }
    }

    // AC1/slice 3: Prepare journals every touched origin's expected content hash *before* either
    // one actually commits.
    [Fact]
    public async Task PrepareAsync_TwoOrigins_JournalsBothExpectedHashesBeforeEitherCommits()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var origin1 = Directory.CreateTempSubdirectory("medit-journal-origin1-").FullName;
        var origin2 = Directory.CreateTempSubdirectory("medit-journal-origin2-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            var plugin1Path = WritePlugin(origin1, "Origin1.esp", out var npc1FormKey);
            var plugin2Path = WritePlugin(origin2, "Origin2.esp", out var npc2FormKey);
            await VendorAsync(vendor, origin1, plugin1Path, "Origin1.esp", npc1FormKey);
            await VendorAsync(vendor, origin2, plugin2Path, "Origin2.esp", npc2FormKey);
            Assert.Equal(1, CommitCount(ledger, origin1));
            Assert.Equal(1, CommitCount(ledger, origin2));

            var prepared = await committer.PrepareAsync([
                new LedgerTouchedRecord(origin1, "Origin1.esp", "npc_", npc1FormKey),
                new LedgerTouchedRecord(origin2, "Origin2.esp", "npc_", npc2FormKey),
            ], GameRelease.Fallout4);

            // Nothing advanced yet.
            Assert.Equal(1, CommitCount(ledger, origin1));
            Assert.Equal(1, CommitCount(ledger, origin2));

            var journal = Assert.Single(ledger.ReadJournals(), j => j.GroupId == prepared.GroupId);
            Assert.Equal(2, journal.Entries.Count);
            foreach (var entry in journal.Entries)
            {
                var actual = ledger.WriteTree(entry.OriginFolder);
                Assert.Equal(actual, entry.ExpectedContentHash);
            }

            // Mutation-testing finding (#372 review): nothing asserted the deterministic origin
            // order the lock-ordering invariant depends on was actually ascending (a mutant flipping
            // PrepareAsync's own OrderBy to descending survived). Expected order computed
            // independently here, not by calling the same sort under test.
            var expectedOrder = new[] { Path.GetFullPath(origin1), Path.GetFullPath(origin2) }
                .OrderBy(x => x, StringComparer.Ordinal)
                .ToList();
            Assert.Equal(expectedOrder, prepared.Attempts.Select(a => a.Attempt.OriginFolder).ToList());
            Assert.Equal(expectedOrder, journal.Entries.Select(e => e.OriginFolder).ToList());

            // Clean up: actually advance so the temp dirs' gitdirs don't leak a held gate/lock —
            // not asserted on, just hygiene for the next test in the process.
            await committer.AdvanceAsync(prepared);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(origin1, recursive: true);
            Directory.Delete(origin2, recursive: true);
        }
    }

    // Mutation-testing finding (#372 review): the "nothing committed" branch's attempt.Dispose()
    // call had nothing asserting the per-origin gate it holds was actually released — a mutant
    // deleting that Dispose() survived. BeginAttemptAsync on the same origin, run right after,
    // must complete promptly rather than hang waiting on a gate PrepareAsync never released (same
    // WaitAsync(timeout)-fails-loudly idiom LedgerCommitAttemptTests already uses for this).
    [Fact]
    public async Task PrepareAsync_NothingLedgerTrackedInTheOrigin_ReleasesTheGate()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-journal-origin-").FullName;
        try
        {
            var (_, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "NeverVendored.esp";
            WritePlugin(originFolder, pluginFileName, out var npcFormKey);

            // Never vendored — nothing this touches is ledger-tracked, so PrepareAsync's own
            // "committed.Count == 0" branch runs and disposes the attempt without ever staging or
            // journaling anything.
            var prepared = await committer.PrepareAsync(
                [new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npcFormKey)], GameRelease.Fallout4);
            Assert.Empty(prepared.Attempts);
            Assert.Empty(prepared.Entries);

            using var second = await ledger.BeginAttemptAsync(originFolder).WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // AC2 — the headline scenario: crash injected between two origins' ref advances. Recovery
    // (a fresh LedgerRepository, standing in for a restarted process) names the lagging repo via
    // its journal and completes it; the already-advanced repo is untouched; final state is
    // consistent (both origins carry their save commit, no journal left behind).
    [Fact]
    public async Task Recover_CrashBetweenTwoOriginsAdvancing_CompletesTheLaggingRepoAndLeavesNoJournal()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var origin1 = Directory.CreateTempSubdirectory("medit-journal-origin1-").FullName;
        var origin2 = Directory.CreateTempSubdirectory("medit-journal-origin2-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            var plugin1Path = WritePlugin(origin1, "Origin1.esp", out var npc1FormKey);
            var plugin2Path = WritePlugin(origin2, "Origin2.esp", out var npc2FormKey);
            await VendorAsync(vendor, origin1, plugin1Path, "Origin1.esp", npc1FormKey);
            await VendorAsync(vendor, origin2, plugin2Path, "Origin2.esp", npc2FormKey);
            Assert.Equal(1, CommitCount(ledger, origin1));
            Assert.Equal(1, CommitCount(ledger, origin2));

            var prepared = await committer.PrepareAsync([
                new LedgerTouchedRecord(origin1, "Origin1.esp", "npc_", npc1FormKey),
                new LedgerTouchedRecord(origin2, "Origin2.esp", "npc_", npc2FormKey),
            ], GameRelease.Fallout4);

            // Advance the first prepared origin for real — its commit lands, its journal entry is
            // removed. The second is left exactly as Prepare staged it: never committed, never
            // disposed — the "crash" — simulating the process dying between the two Advance calls
            // CommitGroupSaveAsync would otherwise have made in sequence.
            var expectedLaggingEntry = prepared.Entries.Single(e => e.OriginFolder != prepared.Attempts[0].Attempt.OriginFolder);
            await committer.AdvanceOneAsync(prepared.GroupId, prepared.Attempts[0], prepared.Entries);

            var advancedOrigin = prepared.Attempts[0].Attempt.OriginFolder;
            var laggingOrigin = advancedOrigin == Path.GetFullPath(origin1) ? Path.GetFullPath(origin2) : Path.GetFullPath(origin1);
            Assert.Equal(2, CommitCount(ledger, advancedOrigin));
            Assert.Equal(1, CommitCount(ledger, laggingOrigin)); // still just the vendor baseline

            var leftoverJournal = Assert.Single(ledger.ReadJournals());
            var leftoverEntry = Assert.Single(leftoverJournal.Entries);
            Assert.Equal(laggingOrigin, leftoverEntry.OriginFolder);
            Assert.Equal(expectedLaggingEntry.ExpectedContentHash, leftoverEntry.ExpectedContentHash);

            // "Process restart": a brand-new LedgerRepository instance against the same root.
            var freshLedger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            freshLedger.Recover();

            Assert.Equal(2, CommitCount(freshLedger, laggingOrigin)); // completed
            Assert.Equal(2, CommitCount(freshLedger, advancedOrigin)); // unaffected
            Assert.Empty(freshLedger.ReadJournals());

            var (gitDir, workTree) = freshLedger.PathsFor(laggingOrigin);
            var message = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%B", "main");
            Assert.Equal(expectedLaggingEntry.Message, message.TrimEnd('\n'));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(origin1, recursive: true);
            Directory.Delete(origin2, recursive: true);
        }
    }

    // AC3: recovery refuses loudly when the worktree no longer matches journaled intent — nothing
    // committed, the journal entry survives for manual inspection, and the divergence is logged at
    // Error naming the repo.
    [Fact]
    public async Task Recover_JournaledOriginNoLongerMatchesEitherHeadOrStagedIndex_RefusesLoudly()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-journal-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "Diverge.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npcFormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npcFormKey);
            Assert.Equal(1, CommitCount(ledger, originFolder));

            var prepared = await committer.PrepareAsync(
                [new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npcFormKey)], GameRelease.Fallout4);
            var journaledEntry = Assert.Single(prepared.Entries);

            // Something else clears the staged content before the crash is "discovered" — the
            // index no longer matches what was journaled, and HEAD (still just the vendor
            // baseline) never did either.
            ledger.ResetIndexToHead(originFolder);

            var (freshLedger, log) = FreshLedgerWithLog(ledgerRoot);
            freshLedger.Recover();

            Assert.Equal(1, CommitCount(freshLedger, originFolder)); // nothing new committed
            var leftoverJournal = Assert.Single(freshLedger.ReadJournals());
            var leftoverEntry = Assert.Single(leftoverJournal.Entries);
            Assert.Equal(journaledEntry.ExpectedContentHash, leftoverEntry.ExpectedContentHash);

            Assert.Contains(log, e => e.Level == LogLevel.Error && e.Message.Contains(Path.GetFullPath(originFolder), StringComparison.Ordinal));

            // Clean up the still-open in-memory attempt from PrepareAsync so its gate is released.
            prepared.Attempts[0].Attempt.Dispose();
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // Mutation-testing finding (#372 review): the journal-rewrite branch (some entries resolved,
    // some refused) was only ever exercised where the rewritten content happened to be
    // byte-identical to what was already on disk (a one-entry journal whose only entry refuses) —
    // a mutant that rewrites the wrong content, or the wrong count, could still pass. A genuinely
    // mixed two-entry batch — one resolves, one refuses — makes the rewritten file's content a
    // strict, checkable subset of what Prepare originally journaled.
    [Fact]
    public async Task Recover_MixedBatchOneResolvesOneRefuses_JournalAfterwardsContainsExactlyTheRefusedEntry()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var origin1 = Directory.CreateTempSubdirectory("medit-journal-origin1-").FullName;
        var origin2 = Directory.CreateTempSubdirectory("medit-journal-origin2-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            var plugin1Path = WritePlugin(origin1, "Origin1.esp", out var npc1FormKey);
            var plugin2Path = WritePlugin(origin2, "Origin2.esp", out var npc2FormKey);
            await VendorAsync(vendor, origin1, plugin1Path, "Origin1.esp", npc1FormKey);
            await VendorAsync(vendor, origin2, plugin2Path, "Origin2.esp", npc2FormKey);

            var prepared = await committer.PrepareAsync([
                new LedgerTouchedRecord(origin1, "Origin1.esp", "npc_", npc1FormKey),
                new LedgerTouchedRecord(origin2, "Origin2.esp", "npc_", npc2FormKey),
            ], GameRelease.Fallout4);
            Assert.Equal(2, prepared.Entries.Count);

            // origin1 is left exactly as Prepare staged it — untouched, so its staged index still
            // matches the journal: Recover resolves it by completing the commit directly. origin2's
            // index is disturbed before recovery runs — a genuine divergence, so it refuses.
            var origin2Full = Path.GetFullPath(origin2);
            var origin2Entry = prepared.Entries.Single(e => e.OriginFolder == origin2Full);
            ledger.ResetIndexToHead(origin2);

            var freshLedger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            freshLedger.Recover();

            var journal = Assert.Single(freshLedger.ReadJournals(), j => j.GroupId == prepared.GroupId);
            var remainingEntry = Assert.Single(journal.Entries);
            Assert.Equal(origin2Entry, remainingEntry);

            // Clean up: origin1's PreparedOrigin was resolved by Recover's own direct commit, not
            // through AdvanceOneAsync — its attempt object never disposed, so it still holds the
            // gate. Releasing it here is a harmless no-op against a repo already at the state
            // Recover committed it to (git reset on an already-committed path is a no-op).
            prepared.Attempts.Single(a => a.Attempt.OriginFolder != origin2Full).Attempt.Dispose();
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(origin1, recursive: true);
            Directory.Delete(origin2, recursive: true);
        }
    }

    // Mutation-testing finding (#372 review): a crash landing *after* the real git commit succeeds
    // but *before* this process gets to remove the journal entry — recovery must classify this as
    // already-advanced (HEAD's tree already matches) and drop the entry, never retry CommitStaged
    // against a repo with nothing new to commit (which would itself fail and leave the entry stuck
    // as a false "refused"). One test for both the HEAD-tree read and its equality check.
    [Fact]
    public async Task Recover_CommitAlreadyLandedButJournalEntryNotYetRemoved_ClassifiesAlreadyAdvanced_DropsEntryWithoutError()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-journal-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "AlreadyAdvanced.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npcFormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npcFormKey);
            Assert.Equal(1, CommitCount(ledger, originFolder));

            var prepared = await committer.PrepareAsync(
                [new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npcFormKey)], GameRelease.Fallout4);
            var entry = Assert.Single(prepared.Entries);
            Assert.Equal(Path.GetFullPath(originFolder), entry.OriginFolder);

            // The real commit lands — via the attempt directly, not AdvanceOneAsync — so the
            // journal entry Prepare wrote is deliberately left on disk: exactly the "crash after
            // the commit succeeded but before this process removed the entry" window.
            prepared.Attempts[0].Attempt.Commit(prepared.Attempts[0].Message);
            Assert.Equal(2, CommitCount(ledger, originFolder));
            Assert.Single(ledger.ReadJournals(), j => j.GroupId == prepared.GroupId); // still there

            var (freshLedger, log) = FreshLedgerWithLog(ledgerRoot);
            freshLedger.Recover();

            // No second commit was attempted — exactly the one the real commit above produced.
            Assert.Equal(2, CommitCount(freshLedger, originFolder));
            Assert.Empty(freshLedger.ReadJournals()); // dropped, not left behind as "refused"
            Assert.DoesNotContain(log, e => e.Level >= LogLevel.Warning);

            prepared.Attempts[0].Attempt.Dispose(); // release the gate the still-open attempt holds
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // AC4: no journal on disk at all (clean prior shutdown) — Recover is a no-op, not a throw.
    [Fact]
    public void Recover_NoJournalDirectory_IsANoOp()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-journal-ledger-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.Recover(); // must not throw
            Assert.Empty(ledger.ReadJournals());
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }

    // Slice 8 / AC1 "reports which repos are incomplete": a *live* (non-crashed) commit-phase
    // failure — the git commit itself fails, not the staging that precedes it — must still restore
    // a delete's removed working-tree file (the #373 guarantee StageOriginAsync's own staging-phase
    // catch already had) now that the commit call has moved to a separate phase (Advance) outside
    // that catch. Forced via a stale index.lock, deterministic and real-git, no mocking.
    [Fact]
    public async Task AdvanceOneAsync_CommitPhaseFailureAfterADelete_RestoresTheDeletedFileAndLogs()
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
            var (vendor, committer, ledger) = MakeCollaborators(
                ledgerRoot, loggerFactory.CreateLogger<LedgerRepository>(), loggerFactory.CreateLogger<LedgerGroupCommitter>());

            const string pluginFileName = "CommitFailure.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npcFormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npcFormKey);
            Assert.Equal(1, CommitCount(ledger, originFolder));

            var relativePath = LedgerRecordPath.For(pluginFileName, "npc_", npcFormKey);
            var absolutePath = Path.Combine(originFolder, relativePath);
            var originalContent = await File.ReadAllTextAsync(absolutePath);

            var prepared = await committer.PrepareAsync(
                [new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npcFormKey, ChangeType: PendingChangeConstants.DeleteChangeType)],
                GameRelease.Fallout4);

            Assert.False(File.Exists(absolutePath)); // the delete's own working-tree mutation already ran

            // Force the real `git commit` call to fail: a stale index.lock is exactly what git
            // itself refuses to commit past.
            var (gitDir, _) = ledger.PathsFor(originFolder);
            var lockPath = Path.Combine(gitDir, "index.lock");
            await File.WriteAllTextAsync(lockPath, string.Empty);
            try
            {
                await committer.AdvanceAsync(prepared);
            }
            finally
            {
                if (File.Exists(lockPath)) File.Delete(lockPath);
            }

            Assert.Equal(1, CommitCount(ledger, originFolder)); // no new commit landed
            Assert.True(File.Exists(absolutePath)); // restored, byte-for-byte
            Assert.Equal(originalContent, await File.ReadAllTextAsync(absolutePath));
            Assert.Empty(ledger.ReadJournals()); // this process gave up on it — nothing left for Recover

            Assert.Contains(entries, e => e.Level == LogLevel.Warning && e.Message.Contains("Ledger commit failed", StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
