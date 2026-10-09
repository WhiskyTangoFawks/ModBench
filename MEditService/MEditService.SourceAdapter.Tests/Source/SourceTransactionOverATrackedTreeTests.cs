using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceTransactionOverATrackedTreeTests : IDisposable
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _firstFolder = new("medit-batch-a-");

    public void Dispose() => _firstFolder.Dispose();

    private static string BodyOf(string pluginName, string editorId) =>
        $"{{\n  \"FormKey\": \"000800:{pluginName}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    private static string OriginalNpcPathSpelledBeforeAnyRepositoryExistsToAsk(string pluginName) =>
        Path.Combine("plugin-source", pluginName, "Npcs", $"Original - 000800_{pluginName}.json");

    private static SourceRepository Track(string modFolder, string pluginName, params TreeFile[] alsoWrite)
    {
        PluginBaselines.Track(
            modFolder,
            [
                new TreeFile(OriginalNpcPathSpelledBeforeAnyRepositoryExistsToAsk(pluginName), Encoding.UTF8.GetBytes(BodyOf(pluginName, "Original"))),
                .. alsoWrite,
            ]);
        return SourceRepository.Open(TestMod.In(modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
    }

    private static (TreeFile[] Files, FormKey Cell) WorldspaceWithAnExteriorCellBeneathWhoseRemovalTakesASubtreeNotAFile(string pluginName)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "ExteriorCell", WaterHeight = 50f };
        cell.Temporary.Add(new PlacedObject(mod) { EditorID = "ExteriorRef" });
        var worldspace = new Worldspace(mod) { EditorID = "World" };

        byte[] Serialize(IMajorRecordGetter record) =>
            Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(record, Release));

        string Leaf(IMajorRecordGetter record) =>
            $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

        var root = PluginSourceRoot.For(pluginName);
        return (
        [
            new TreeFile(
                PluginSourceRoot.ContainerDocument(Path.Combine(root, "Worldspaces", Leaf(worldspace))), Serialize(worldspace)),
            new TreeFile(
                PluginSourceRoot.ContainerDocument(Path.Combine(root, "Worldspaces", Leaf(worldspace), "0, 0", "0, 0", Leaf(cell))),
                Serialize(cell)),
        ], cell.FormKey);
    }

    [Fact]
    public void ABatchPuttingAContainerTheTreeDoesNotHold_PlacesItAndItsBlocks_AndItsRollbackTakesThemBack()
    {
        var repository = Track(_firstFolder, "First.esp");
        var plugin = new PluginAddress("First.esp", TestMod.Name);
        var cell = new SourceDocument("000900:First.esp", "cell", "FreshCell", "{\n  \"FormKey\": \"000900:First.esp\"\n}");
        var before = TreeSnapshot.Of(_firstFolder);

        var left = TransactionRollback.After(repository, transaction =>
        {
            transaction.Put(repository, plugin, cell);
            Assert.Equal(cell.Body, repository.RecordOf(plugin, cell.Identity).Value()?.Body);
        });

        Assert.Null(left);
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }

    [Fact]
    public void ABatchWhoseRekeyFollowsAPut_PutsBothBackOnRollback()
    {
        var repository = Track(_firstFolder, "First.esp");
        var plugin = new PluginAddress("First.esp", TestMod.Name);
        var before = TreeSnapshot.Of(_firstFolder);

        var left = TransactionRollback.After(repository, transaction =>
        {
            var siblingInTheGroupFolderTrackAlreadyMade =
                new SourceDocument("000900:First.esp", "npc_", "Sibling", "{\n  \"FormKey\": \"000900:First.esp\"\n}");
            transaction.Put(repository, plugin, siblingInTheGroupFolderTrackAlreadyMade);
            transaction.Rekey(repository, plugin, new RecordIdentity("000800:First.esp", "npc_", "Original"), "000901:First.esp");
            Assert.NotEqual(before, TreeSnapshot.Of(_firstFolder));
        });

        Assert.Null(left);
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }
}
