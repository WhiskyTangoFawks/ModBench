using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
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
                factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), ledgerReconciler: reconciler);
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
}
