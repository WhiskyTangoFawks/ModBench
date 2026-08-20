using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Session;

/// <summary>
/// #410/ADR-0041: loading a session touches nothing in a mod folder.
///
/// The stage-1 lifecycle reconciler (#392) did the opposite: on every load it looked for
/// <c>&lt;plugin&gt;.ledger</c> trees whose plugin was no longer physically present and renamed or
/// (biased toward) *deleted* them — reconciling hidden external gitdirs that no longer exist.
/// ADR-0041 replaces that whole model with tracking as a deliberate user gesture, so this is now a
/// straightforward violation of the project's never-assume-exclusive-ownership rule: text a user
/// (or Track) put in a mod folder is not Modbench's to remove because a binary went missing.
///
/// The positive control is the load itself — the session must really have loaded and indexed the
/// plugin that *is* present, or "nothing was deleted" would be true of a load that did nothing.
/// </summary>
public sealed class SessionLeavesLedgerTreesAloneTests
{
    [Fact]
    public void LoadExplicit_LedgerTreeWhosePluginIsGone_IsLeftExactlyWhereItIs()
    {
        var root = Directory.CreateTempSubdirectory("medit-leave-ledger-origin-").FullName;
        var originFolder = Path.Combine(root, "ModA");
        Directory.CreateDirectory(originFolder);
        var gameDir = Directory.CreateTempSubdirectory("medit-leave-ledger-game-").FullName;
        try
        {
            var stillHerePath = Path.Combine(originFolder, "StillHere.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("StillHere.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("StillHereNpc");
            mod.WriteToBinary(stillHerePath);

            // Per-record text for a plugin that is no longer on disk beside it — exactly the
            // "orphan" shape the reconciler used to sweep away.
            var orphanTree = Path.Combine(originFolder, "Removed.esp.ledger");
            var orphanFile = Path.Combine(orphanTree, "records", "Removed.esp", "000800.json");
            Directory.CreateDirectory(Path.GetDirectoryName(orphanFile)!);
            File.WriteAllText(orphanFile, "{\"formKey\":\"000800:Removed.esp\"}");

            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory);
            ISessionManager sessionManager = manager;

            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("StillHere.esp", stillHerePath, "ModA", true)],
                GameRelease.Fallout4);

            // Positive control: the load really happened and really indexed the present plugin.
            Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("StillHere.esp", "ModA"))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);

            Assert.True(Directory.Exists(orphanTree), "the orphaned ledger tree must survive the load");
            Assert.Equal("{\"formKey\":\"000800:Removed.esp\"}", File.ReadAllText(orphanFile));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
