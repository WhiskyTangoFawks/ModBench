using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

/// <summary>Text a user or Track put in a mod folder is not Modbench's to remove because a binary
/// went missing (ADR-0007, never assume exclusive ownership). The load itself is the positive
/// control.</summary>
public sealed class ReconcileLeavesSourceTreesAloneTests
{
    [Fact]
    public void Reconcile_SourceTreeWhosePluginIsGone_IsLeftExactlyWhereItIs()
    {
        var holder = new LoadOrderHolder();
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

            // Per-record text for a plugin absent from disk beside it, an "orphan": under the root "source/"
            // layout, a plugin folder inside it with no plugin file left.
            var orphanTree = Path.Combine(originFolder, "source", "Removed.esp");
            var orphanFile = Path.Combine(orphanTree, "records", "Removed.esp", "000800.json");
            Directory.CreateDirectory(Path.GetDirectoryName(orphanFile)!);
            File.WriteAllText(orphanFile, "{\"formKey\":\"000800:Removed.esp\"}");

            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
            IndexProjector index = manager;

            index.Reconcile(holder,
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
