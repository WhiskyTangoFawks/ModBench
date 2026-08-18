using MEditService.Core.Ledger;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #392: <see cref="LedgerLifecycleReconciler"/>'s own contract at its own public seam — real git
/// throughout (no HTTP, no session, no DuckDB), same seam choice as
/// <see cref="LedgerGroupCommitterTests"/>/<see cref="RecordVendorApplyFieldsTests"/>. The
/// candidate-content-verification delegate stands in for what a real caller (<c>SessionManager</c>,
/// slice 3) resolves against the indexed record repository — faking that one collaborator is not
/// mocking git, the seam this test suite never touches.
/// </summary>
public sealed class LedgerLifecycleReconcilerTests
{
    private static LedgerLifecycleReconciler MakeReconciler(LedgerRepository ledger) =>
        new(ledger, NullLogger<LedgerLifecycleReconciler>.Instance);

    private static PluginMetadata Present(string name, string originFolder, string origin = "SomeMod") =>
        new(name, Path.Combine(originFolder, name), LoadOrderIndex: 0, IsLight: false, IsMaster: false,
            Masters: [], RecordCount: 0, IsImmutable: false, Origin: origin);

    private static void VendorRawRecord(LedgerRepository ledger, string originFolder, string relativePath, string content)
    {
        var absolutePath = Path.Combine(originFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        File.WriteAllText(absolutePath, content);
        ledger.StagePath(originFolder, relativePath);
    }

    private static int CommitCount(LedgerRepository ledger, string originFolder)
    {
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        return log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
    }

    private static string CommitLogFollow(LedgerRepository ledger, string originFolder, string relativePath)
    {
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        return GitCli.Run(gitDir, workTree, "log", "--follow", "--format=%s", "main", "--", relativePath.Replace('\\', '/'));
    }

    // Two plugins share one origin folder, both already ledger-tracked; "Old.esp" is removed while
    // "AlreadyTracked.esp" survives with its own separate tree. AlreadyTracked.esp is present but
    // already has a ledger tree of its own, so it is never a rename candidate — this proves that
    // exclusion, not merely "an orphan disappears somehow".
    [Fact]
    public async Task OrphanWithNoUntrackedCandidatePresent_IsRemoved_SurvivingPluginsTreeUntouched()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-reconcile-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-reconcile-origin-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(originFolder);
            var orphanRelative = LedgerRecordPath.For("Old.esp", "npc_", "000800:Old.esp");
            var survivorRelative = LedgerRecordPath.For("AlreadyTracked.esp", "npc_", "000800:AlreadyTracked.esp");
            VendorRawRecord(ledger, originFolder, orphanRelative, "FormKey: 000800:Old.esp\n");
            VendorRawRecord(ledger, originFolder, survivorRelative, "FormKey: 000800:AlreadyTracked.esp\n");
            ledger.CommitStaged(originFolder, "vendor: baseline");
            Assert.Equal(1, CommitCount(ledger, originFolder));

            var reconciler = MakeReconciler(ledger);
            await reconciler.ReconcileAsync(
                [Present("AlreadyTracked.esp", originFolder)],
                static (_, _, _, _) => throw new InvalidOperationException("no candidate should ever be checked here"));

            Assert.False(Directory.Exists(Path.Combine(originFolder, "Old.esp.ledger")));
            Assert.False(ledger.IsTrackedAtHead(originFolder, orphanRelative));
            Assert.True(Directory.Exists(Path.Combine(originFolder, "AlreadyTracked.esp.ledger")));
            Assert.True(ledger.IsTrackedAtHead(originFolder, survivorRelative));
            Assert.Equal(2, CommitCount(ledger, originFolder));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    [Fact]
    public async Task NothingOrphaned_NoCommitIsMade()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-reconcile-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-reconcile-origin-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(originFolder);
            var relative = LedgerRecordPath.For("Present.esp", "npc_", "000800:Present.esp");
            VendorRawRecord(ledger, originFolder, relative, "FormKey: 000800:Present.esp\n");
            ledger.CommitStaged(originFolder, "vendor: baseline");
            Assert.Equal(1, CommitCount(ledger, originFolder));

            var reconciler = MakeReconciler(ledger);
            await reconciler.ReconcileAsync(
                [Present("Present.esp", originFolder)],
                static (_, _, _, _) => throw new InvalidOperationException("no candidate should ever be checked here"));

            Assert.Equal(1, CommitCount(ledger, originFolder));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // The misclassification guard (coordinator revision): an orphan plus a present-but-genuinely-
    // unrelated untracked plugin in the same origin folder must never be paired up on count alone.
    // The delegate stands in for the candidate's real indexed records and never affirms a match, so
    // every one of the orphan's FormKeys fails to resolve against it — zero qualifying candidates,
    // plain removal, the unrelated plugin gains no ledger tree of its own.
    [Fact]
    public async Task OrphanPlusUnrelatedPresentPlugin_ContentNeverMatches_OrphanRemovedNotRenamed()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-reconcile-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-reconcile-origin-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(originFolder);
            var orphanRelative = LedgerRecordPath.For("MyMod.esp", "npc_", "000800:MyMod.esp");
            VendorRawRecord(ledger, originFolder, orphanRelative, "FormKey: 000800:MyMod.esp\n");
            ledger.CommitStaged(originFolder, "vendor: baseline");

            var reconciler = MakeReconciler(ledger);
            await reconciler.ReconcileAsync(
                [Present("MyPatch.esp", originFolder)],
                static (_, _, _, _) => false); // MyPatch.esp never actually carries MyMod's records

            Assert.False(Directory.Exists(Path.Combine(originFolder, "MyMod.esp.ledger")));
            Assert.False(ledger.IsTrackedAtHead(originFolder, orphanRelative));
            Assert.False(Directory.Exists(Path.Combine(originFolder, "MyPatch.esp.ledger")));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // The positive rename path, exercising both remap branches the coordinator's revision
    // specifically called out: an authored record (FormKey.ModKey == the orphan's own plugin name)
    // must be checked under the *candidate's* name, while an override record (FormKey.ModKey ==
    // some other master) must be checked unchanged — the candidate only qualifies if every one of
    // the orphan's FormKeys resolves under the right identity. History survives the rename: git log
    // --follow on the new path reaches back through both the reconcile commit and the original
    // vendor commit.
    [Fact]
    public async Task OrphanWithExactlyOneQualifyingCandidate_IsRenamed_HistorySurvives()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-reconcile-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-reconcile-origin-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(originFolder);
            var authoredRelative = LedgerRecordPath.For("Old.esp", "npc_", "000800:Old.esp");
            var overrideRelative = LedgerRecordPath.For("Old.esp", "npc_", "000900:SomeMaster.esm");
            VendorRawRecord(ledger, originFolder, authoredRelative, "FormKey: 000800:Old.esp\n");
            VendorRawRecord(ledger, originFolder, overrideRelative, "FormKey: 000900:SomeMaster.esm\n");
            ledger.CommitStaged(originFolder, "vendor: baseline");

            var reconciler = MakeReconciler(ledger);
            await reconciler.ReconcileAsync(
                [Present("New.esp", originFolder)],
                (recordType, formKey, plugin, _) =>
                    plugin == "New.esp" && recordType == "npc_" &&
                    (formKey == "000800:New.esp" || formKey == "000900:SomeMaster.esm"));

            Assert.False(Directory.Exists(Path.Combine(originFolder, "Old.esp.ledger")));
            Assert.False(ledger.IsTrackedAtHead(originFolder, authoredRelative));
            var newAuthoredRelative = LedgerRecordPath.For("New.esp", "npc_", "000800:Old.esp");
            var newOverrideRelative = LedgerRecordPath.For("New.esp", "npc_", "000900:SomeMaster.esm");
            Assert.True(ledger.IsTrackedAtHead(originFolder, newAuthoredRelative));
            Assert.True(ledger.IsTrackedAtHead(originFolder, newOverrideRelative));

            var followedLog = CommitLogFollow(ledger, originFolder, newAuthoredRelative);
            Assert.Contains("vendor: baseline", followedLog, StringComparison.Ordinal);
            Assert.Contains("reconcile:", followedLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
