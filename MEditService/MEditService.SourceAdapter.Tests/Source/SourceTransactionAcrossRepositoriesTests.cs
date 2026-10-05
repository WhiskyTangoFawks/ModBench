using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceTransactionAcrossRepositoriesTests : IDisposable
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _firstFolder = new("medit-batch-a-");
    private readonly ScratchDirectory _secondFolder = new("medit-batch-b-");

    public void Dispose()
    {
        _firstFolder.Dispose();
        _secondFolder.Dispose();
    }

    private static string BodyOf(string pluginName, string editorId) =>
        $"{{\n  \"FormKey\": \"000800:{pluginName}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    private static string OriginalNpcPathSpelledBeforeAnyRepositoryExistsToAsk(string pluginName) =>
        Path.Combine("plugin-source", pluginName, "Npcs", $"Original - 000800_{pluginName}.json");

    private static SourceRepository Track(string modFolder, string pluginName, params TreeFile[] alsoWrite)
    {
        PluginBaselines.Track(
            modFolder, SourcePreset.Edits,
            [
                new TreeFile(OriginalNpcPathSpelledBeforeAnyRepositoryExistsToAsk(pluginName), Encoding.UTF8.GetBytes(BodyOf(pluginName, "Original"))),
                .. alsoWrite,
            ]);
        return SourceRepository.Open(modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
    }

    private static (TreeFile[] Files, FormKey Cell) WorldspaceWithAnExteriorCellBeneathWhoseRemovalTakesASubtreeNotAFile(string pluginName)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "ExteriorCell", WaterHeight = 50f };
        cell.Temporary.Add(new PlacedObject(mod) { EditorID = "ExteriorRef" });
        var worldspace = new Worldspace(mod) { EditorID = "World" };

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        byte[] Serialize(IMajorRecordGetter record) =>
            codec.SerializeToBytes(record, Release);

        string Leaf(IMajorRecordGetter record) =>
            $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

        var root = SourceRepository.RootFor(pluginName);
        return (
        [
            new TreeFile(
                Path.Combine(root, "Worldspaces", Leaf(worldspace), "RecordData.json"), Serialize(worldspace)),
            new TreeFile(
                Path.Combine(root, "Worldspaces", Leaf(worldspace), "0, 0", "0, 0", Leaf(cell), "RecordData.json"),
                Serialize(cell)),
        ], cell.FormKey);
    }

    [Fact]
    public void ABatchWhoseSecondPutFails_LeavesBothTreesByteIdenticalToBefore()
    {
        var first = Track(_firstFolder, "First.esp");
        var second = Track(_secondFolder, "Second.esp");
        var firstPlugin = new PluginAddress("First.esp", "FirstMod");
        var secondPlugin = new PluginAddress("Second.esp", "SecondMod");
        var (beforeFirst, beforeSecond) = (TreeSnapshot.Of(_firstFolder), TreeSnapshot.Of(_secondFolder));

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(
            first, firstPlugin,
            new SourceDocument("000800:First.esp", "npc_", "Original", BodyOf("First.esp", "Rewritten")));

        var recordWithNoGroupFolderAndNoDocumentCarryingIt =
            new SourceDocument("00FFFF:Second.esp", "refr", "Nowhere", BodyOf("Second.esp", "Nowhere"));
        Assert.ThrowsAny<Exception>(() => transaction.Put(second, secondPlugin, recordWithNoGroupFolderAndNoDocumentCarryingIt));

        Assert.Empty(transaction.Undo(first));
        Assert.Equal(beforeFirst, TreeSnapshot.Of(_firstFolder));
        Assert.Equal(beforeSecond, TreeSnapshot.Of(_secondFolder));
    }

    [Fact]
    public void ABatchThatSucceeds_LandsEveryRepositorysDocument()
    {
        var first = Track(_firstFolder, "First.esp");
        var second = Track(_secondFolder, "Second.esp");
        var firstPlugin = new PluginAddress("First.esp", "FirstMod");
        var secondPlugin = new PluginAddress("Second.esp", "SecondMod");

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(
            first, firstPlugin, new SourceDocument("000800:First.esp", "npc_", "Original", BodyOf("First.esp", "Rewritten")));
        transaction.Put(
            second, secondPlugin, new SourceDocument("000800:Second.esp", "npc_", "Original", BodyOf("Second.esp", "Rewritten")));

        Assert.Equal(
            BodyOf("First.esp", "Rewritten"),
            first.Get(firstPlugin, new RecordIdentity("000800:First.esp", "npc_", "Original"))?.Body);
        Assert.Equal(
            BodyOf("Second.esp", "Rewritten"),
            second.Get(secondPlugin, new RecordIdentity("000800:Second.esp", "npc_", "Original"))?.Body);
    }

    [Fact]
    public void ABatchAskedToPutAContainerTheTreeDoesNotHold_RefusesBeforeTouchingTheTree_ForMintingItsDirectoriesIsMoreThanTheOneDocumentsBytesABatchEntryHolds()
    {
        var repository = Track(_firstFolder, "First.esp");
        var plugin = new PluginAddress("First.esp", "FirstMod");
        var before = TreeSnapshot.Of(_firstFolder);

        var transaction = new SourceRepository.SourceTransaction();
        var refusal = Assert.Throws<NotSupportedException>(() => transaction.Put(
            repository, plugin,
            new SourceDocument("000900:First.esp", "cell", "FreshCell", "{\n  \"FormKey\": \"000900:First.esp\"\n}")));

        Assert.Contains("000900:First.esp", refusal.Message, StringComparison.Ordinal);
        Assert.Empty(transaction.Undo(repository));
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }

    [Fact]
    public void ABatchWhoseRekeyFollowsAPut_PutsBothBackOnRollback()
    {
        var repository = Track(_firstFolder, "First.esp");
        var plugin = new PluginAddress("First.esp", "FirstMod");
        var before = TreeSnapshot.Of(_firstFolder);

        var transaction = new SourceRepository.SourceTransaction();
        var siblingInTheGroupFolderTrackAlreadyMade =
            new SourceDocument("000900:First.esp", "npc_", "Sibling", "{\n  \"FormKey\": \"000900:First.esp\"\n}");
        transaction.Put(repository, plugin, siblingInTheGroupFolderTrackAlreadyMade);
        transaction.Rekey(
            repository, plugin, new RecordIdentity("000800:First.esp", "npc_", "Original"), "000901:First.esp",
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4),
            new DocumentRekey((document, newFormKey) => document.Body.Replace(document.FormKey, newFormKey, StringComparison.Ordinal), (_, _, _) => null));

        Assert.NotEqual(before, TreeSnapshot.Of(_firstFolder));
        Assert.Empty(transaction.Undo(repository));
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }
}
