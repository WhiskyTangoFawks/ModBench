using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

/// <summary>
/// ADR-0041: loading a load order touches nothing in a mod folder. Tracking is a deliberate user
/// gesture, and the project's never-assume-exclusive-ownership rule applies: text a user (or
/// Track) put in a mod folder is not Modbench's to remove because a binary went missing.
///
/// The positive control is the load itself — the load order must really have loaded and indexed the
/// plugin that *is* present, or "nothing was deleted" would be true of a load that did nothing.
/// </summary>
public sealed class ReconcileLeavesSourceTreesAloneTests
{
    [Fact]
    public void Reconcile_SourceTreeWhosePluginIsGone_IsLeftExactlyWhereItIs()
    {
        var root = Directory.CreateTempSubdirectory("medit-leave-source-origin-").FullName;
        var originFolder = Path.Combine(root, "ModA");
        Directory.CreateDirectory(originFolder);
        var gameDir = Directory.CreateTempSubdirectory("medit-leave-source-game-").FullName;
        try
        {
            var stillHerePath = Path.Combine(originFolder, "StillHere.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("StillHere.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("StillHereNpc");
            mod.WriteToBinary(stillHerePath);

            // Per-record text for a plugin that is no longer on disk beside it — an "orphan":
            // under the root "source/" layout, a plugin folder inside it with no plugin file left.
            var orphanTree = Path.Combine(originFolder, "source", "Removed.esp");
            var orphanFile = Path.Combine(orphanTree, "records", "Removed.esp", "000800.json");
            Directory.CreateDirectory(Path.GetDirectoryName(orphanFile)!);
            File.WriteAllText(orphanFile, "{\"formKey\":\"000800:Removed.esp\"}");

            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            ILoadOrderMirror mirror = manager;

            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("StillHere.esp", stillHerePath, "ModA", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            // Positive control: the load really happened and really indexed the present plugin.
            Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("StillHere.esp", "ModA"))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);

            Assert.True(Directory.Exists(orphanTree), "the orphaned source tree must survive the load");
            Assert.Equal("{\"formKey\":\"000800:Removed.esp\"}", File.ReadAllText(orphanFile));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
