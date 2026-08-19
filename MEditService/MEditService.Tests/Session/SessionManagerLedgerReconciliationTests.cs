using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Session;

/// <summary>
/// #392: the wiring seam — <see cref="SessionManager.LoadExplicit"/> (the real, MO2-backed load
/// path; mirrors <see cref="SessionManagerLoadExplicitOriginTests"/>) actually fires
/// <see cref="LedgerLifecycleReconciler"/> against the session it just indexed, not just that the
/// reconciler works in isolation (<c>LedgerLifecycleReconcilerTests</c> already covers the
/// heuristic itself). "Removed.esp" was ledger-tracked in a prior session and is no longer listed;
/// "StillHere.esp" shares the same origin folder and survives, so the folder is one this load still
/// visits (the scope cut: an origin folder must still provide at least one present plugin).
/// </summary>
public sealed class SessionManagerLedgerReconciliationTests
{
    [Fact]
    public void LoadExplicit_RemovedPluginsOrphanedLedgerTree_IsReconciledAway()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-sm-reconcile-ledger-").FullName;
        var root = Directory.CreateTempSubdirectory("medit-sm-reconcile-origin-").FullName;
        var originFolder = Path.Combine(root, "ModA");
        Directory.CreateDirectory(originFolder);
        var gameDir = Directory.CreateTempSubdirectory("medit-sm-reconcile-game-").FullName;
        try
        {
            var stillHerePath = Path.Combine(originFolder, "StillHere.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("StillHere.esp"), Fallout4Release.Fallout4);
            var stillHereNpc = mod.Npcs.AddNew("StillHereNpc");
            mod.WriteToBinary(stillHerePath);

            // A plugin that used to live here and was ledger-tracked, then removed from disk —
            // built directly with the same raw LedgerRepository primitives
            // LedgerLifecycleReconcilerTests uses, rather than a real vendoring round-trip; only the
            // wiring is under test here. The local FormID is chosen to differ from whatever Mutagen
            // actually assigned StillHere.esp's own NPC above — a coincidental collision there would
            // make this fixture (correctly) look like a genuine content match and rename instead of
            // remove, defeating the point of this test.
            var orphanLocalId = stillHereNpc.FormKey.ID == 0x800u ? 0x900u : 0x800u;
            var orphanFormKeyString = $"{orphanLocalId:X6}:Removed.esp";
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(originFolder);
            var orphanRelative = LedgerRecordPath.For("Removed.esp", "npc_", orphanFormKeyString);
            var orphanAbsolute = Path.Combine(originFolder, orphanRelative);
            Directory.CreateDirectory(Path.GetDirectoryName(orphanAbsolute)!);
            File.WriteAllText(orphanAbsolute, $"FormKey: {orphanFormKeyString}\n");
            ledger.StagePath(originFolder, orphanRelative);
            ledger.CommitStaged(originFolder, "vendor: baseline");

            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            var reconciler = new LedgerLifecycleReconciler(ledger, NullLogger<LedgerLifecycleReconciler>.Instance);
            using var manager = new SessionManager(
                factory, ledgerReconciler: reconciler);
            ISessionManager sessionManager = manager;

            var explicitPlugins = new List<ExplicitPluginInput> { new("StillHere.esp", stillHerePath, "ModA", true) };

            sessionManager.LoadExplicit(gameDir, explicitPlugins, GameRelease.Fallout4);

            Assert.False(Directory.Exists(Path.Combine(originFolder, "Removed.esp.ledger")));
            Assert.False(ledger.IsTrackedAtHead(originFolder, orphanRelative));
            // StillHere.esp is a genuinely unrelated plugin — its own indexed records never satisfy
            // Removed.esp's tracked FormKey, so it must gain no ledger tree of its own either.
            Assert.False(Directory.Exists(Path.Combine(originFolder, "StillHere.esp.ledger")));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(root, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // #392 review finding 6: the pre-#392 behavior pinned — a SessionManager built without a
    // LedgerLifecycleReconciler (the optional-collaborator default every constructor call in the
    // existing suite already relies on) must load exactly as before this ticket: no reconciliation
    // attempt at all, not a null-check that silently degrades into a logged failure every load.
    [Fact]
    public void LoadExplicit_NoReconcilerConfigured_LoadsCleanlyWithNoWarningLogged()
    {
        using var fx = new PluginFixtureBuilder("sm-no-reconciler")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        var entries = new List<LogEntry>();
        var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        var logger = loggerFactory.CreateLogger<SessionManager>();

        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        using var manager = new SessionManager(
            factory, logger: logger);
        ISessionManager sessionManager = manager;

        sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.DoesNotContain(entries, e => e.Level >= LogLevel.Warning);
    }

    // #392 review finding 7: SessionManager.ReconcileLedgerLifecycle's delegate reads
    // repository.GetRecord(..., winnerOnly: false) — an identity check ("does this plugin's own row
    // exist"), not a winner check. A rename candidate whose matching record is currently overridden
    // (and beaten) by another, higher-load-order plugin must still qualify: the candidate's own
    // content really is a continuation of the orphan's, whether or not it happens to be the plugin
    // the game would actually resolve that FormKey to today.
    [Fact]
    public void LoadExplicit_RenameCandidateRecordIsOverriddenByAnotherPlugin_StillQualifiesByIdentityNotWinner()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-sm-reconcile-winner-ledger-").FullName;
        var root = Directory.CreateTempSubdirectory("medit-sm-reconcile-winner-origin-").FullName;
        var masterFolder = Path.Combine(root, "MasterMod");
        var candidateOriginFolder = Path.Combine(root, "CandidateMod");
        var otherOriginFolder = Path.Combine(root, "OtherMod");
        Directory.CreateDirectory(masterFolder);
        Directory.CreateDirectory(candidateOriginFolder);
        Directory.CreateDirectory(otherOriginFolder);
        var gameDir = Directory.CreateTempSubdirectory("medit-sm-reconcile-winner-game-").FullName;
        try
        {
            var masterPath = Path.Combine(masterFolder, "Master.esm");
            var masterMod = new Fallout4Mod(ModKey.FromFileName("Master.esm"), Fallout4Release.Fallout4);
            var masterNpc = masterMod.Npcs.AddNew("MasterNpc");
            masterMod.WriteToBinary(masterPath);
            var masterFormKey = masterNpc.FormKey.ToString();

            // Candidate.esp overrides the master NPC but loses the winner race — Other.esp, loaded
            // after it, overrides the same record and wins.
            var candidatePath = Path.Combine(candidateOriginFolder, "Candidate.esp");
            var candidateMod = new Fallout4Mod(ModKey.FromFileName("Candidate.esp"), Fallout4Release.Fallout4);
            candidateMod.Npcs.GetOrAddAsOverride(masterNpc);
            candidateMod.WriteToBinary(candidatePath);

            var otherPath = Path.Combine(otherOriginFolder, "Other.esp");
            var otherMod = new Fallout4Mod(ModKey.FromFileName("Other.esp"), Fallout4Release.Fallout4);
            otherMod.Npcs.GetOrAddAsOverride(masterNpc);
            otherMod.WriteToBinary(otherPath);

            // Removed.esp used to live in Candidate's own origin folder and overrode the same master
            // NPC — an override record (master-keyed), so it is checked unchanged against the
            // candidate's identity, never remapped by orphan/candidate name.
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            ledger.EnsureRepo(candidateOriginFolder);
            var orphanRelative = LedgerRecordPath.For("Removed.esp", "npc_", masterFormKey);
            var orphanAbsolute = Path.Combine(candidateOriginFolder, orphanRelative);
            Directory.CreateDirectory(Path.GetDirectoryName(orphanAbsolute)!);
            File.WriteAllText(orphanAbsolute, $"FormKey: {masterFormKey}\n");
            ledger.StagePath(candidateOriginFolder, orphanRelative);
            ledger.CommitStaged(candidateOriginFolder, "vendor: baseline");

            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            var reconciler = new LedgerLifecycleReconciler(ledger, NullLogger<LedgerLifecycleReconciler>.Instance);
            using var manager = new SessionManager(
                factory, ledgerReconciler: reconciler);
            ISessionManager sessionManager = manager;

            // Load order: Master first, Candidate second (loses the winner race), Other last (wins)
            // — standard last-loaded-wins.
            var explicitPlugins = new List<ExplicitPluginInput>
            {
                new("Master.esm", masterPath, "MasterMod", true),
                new("Candidate.esp", candidatePath, "CandidateMod", true),
                new("Other.esp", otherPath, "OtherMod", true),
            };

            sessionManager.LoadExplicit(gameDir, explicitPlugins, GameRelease.Fallout4);

            // Sanity: Candidate really did lose the winner race for this FormKey — Other.esp is the
            // global winner. If this weren't true, the test below would pass even with
            // winnerOnly:true and prove nothing about which flag production code actually uses.
            var repository = (IRecordRepository)manager.Repository!;
            var globalWinner = repository.GetRecord("npc_", masterFormKey, null, null, winnerOnly: true);
            Assert.NotNull(globalWinner);
            Assert.Equal("Other.esp", globalWinner.Plugin);
            Assert.Null(repository.GetRecord("npc_", masterFormKey, "Candidate.esp", "CandidateMod", winnerOnly: true));
            Assert.NotNull(repository.GetRecord("npc_", masterFormKey, "Candidate.esp", "CandidateMod", winnerOnly: false));

            // The reconciliation itself: Removed.esp.ledger renamed onto Candidate.esp despite
            // Candidate.esp not being the winner for that FormKey — an identity check, not a winner
            // check.
            Assert.False(Directory.Exists(Path.Combine(candidateOriginFolder, "Removed.esp.ledger")));
            Assert.True(Directory.Exists(Path.Combine(candidateOriginFolder, "Candidate.esp.ledger")));
            var newRelative = LedgerRecordPath.For("Candidate.esp", "npc_", masterFormKey);
            Assert.True(ledger.IsTrackedAtHead(candidateOriginFolder, newRelative));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(root, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
