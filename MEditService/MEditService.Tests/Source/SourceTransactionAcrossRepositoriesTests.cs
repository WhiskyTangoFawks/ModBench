using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>One batch of puts and removes across two tracked mod folders: either every tree takes it,
/// or every tree goes back (ADR-0007).</summary>
public sealed class SourceTransactionAcrossRepositoriesTests : IDisposable
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly string _firstFolder = Directory.CreateTempSubdirectory("medit-batch-a-").FullName;
    private readonly string _secondFolder = Directory.CreateTempSubdirectory("medit-batch-b-").FullName;

    public void Dispose()
    {
        foreach (var folder in new[] { _firstFolder, _secondFolder })
        {
            try { Directory.Delete(folder, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }

    private static string BodyOf(string pluginName, string editorId) =>
        $"{{\n  \"FormKey\": \"000800:{pluginName}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    private static SourceRepository Track(string modFolder, string pluginName, params PristineFile[] alsoWrite)
    {
        SourceRepository.Track(
            modFolder, SourcePreset.Edits,
            [
                new PristineFile(
                    SourceRepository.FlatPathFor(pluginName, "npc_", $"000800:{pluginName}", "Original", Release),
                    Encoding.UTF8.GetBytes(BodyOf(pluginName, "Original"))),
                .. alsoWrite,
            ],
            new TrackProvenance(null, null, new Dictionary<string, string>()));
        return SourceRepository.Open(modFolder, Release)!;
    }

    // A worldspace with an exterior cell beneath it: the one shape whose removal takes a whole
    // subtree rather than a file.
    private static (PristineFile[] Files, FormKey Cell) ContainerFiles(string pluginName)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "ExteriorCell", WaterHeight = 50f };
        cell.Temporary.Add(new PlacedObject(mod) { EditorID = "ExteriorRef" });
        var worldspace = new Worldspace(mod) { EditorID = "World" };

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        byte[] Serialize(IMajorRecordGetter record) =>
            codec.SerializeToBytesAsync(record, Release).GetAwaiter().GetResult();

        string Leaf(IMajorRecordGetter record) =>
            $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

        var root = SourceRepository.RootFor(pluginName);
        return (
        [
            new PristineFile(
                Path.Combine(root, "Worldspaces", Leaf(worldspace), "RecordData.json"), Serialize(worldspace)),
            new PristineFile(
                Path.Combine(root, "Worldspaces", Leaf(worldspace), "0, 0", "0, 0", Leaf(cell), "RecordData.json"),
                Serialize(cell)),
        ], cell.FormKey);
    }

    [Fact]
    public void ABatchWhoseSecondPutFails_LeavesBothTreesByteIdenticalToBefore()
    {
        var first = Track(_firstFolder, "First.esp");
        var second = Track(_secondFolder, "Second.esp");
        var firstPlugin = new PluginKey("First.esp", "FirstMod");
        var secondPlugin = new PluginKey("Second.esp", "SecondMod");
        var (beforeFirst, beforeSecond) = (TreeSnapshot.Of(_firstFolder), TreeSnapshot.Of(_secondFolder));

        var transaction = new SourceTransaction();
        transaction.Put(
            first, firstPlugin,
            new SourceDocument("000800:First.esp", "npc_", "Original", BodyOf("First.esp", "Rewritten")));

        // The second repository's write dies where a real one can: the record has no group folder of
        // its own and no document carries it, so the tree has nowhere to put it.
        Assert.ThrowsAny<Exception>(() => transaction.Put(
            second, secondPlugin,
            new SourceDocument("00FFFF:Second.esp", "refr", "Nowhere", BodyOf("Second.esp", "Nowhere"))));

        Assert.Empty(transaction.Rollback());
        Assert.Equal(beforeFirst, TreeSnapshot.Of(_firstFolder));
        Assert.Equal(beforeSecond, TreeSnapshot.Of(_secondFolder));
    }

    [Fact]
    public void ABatchThatSucceeds_LandsEveryRepositorysDocument()
    {
        var first = Track(_firstFolder, "First.esp");
        var second = Track(_secondFolder, "Second.esp");
        var firstPlugin = new PluginKey("First.esp", "FirstMod");
        var secondPlugin = new PluginKey("Second.esp", "SecondMod");

        var transaction = new SourceTransaction();
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
    public void ABatchAskedToRemoveAContainer_RefusesBeforeTouchingTheTree()
    {
        var (files, cell) = ContainerFiles("First.esp");
        var repository = Track(_firstFolder, "First.esp", files);
        var plugin = new PluginKey("First.esp", "FirstMod");
        var before = TreeSnapshot.Of(_firstFolder);

        var transaction = new SourceTransaction();
        var refusal = Assert.Throws<NotSupportedException>(
            () => transaction.Remove(repository, plugin, new RecordIdentity(cell.ToString(), "cell", "ExteriorCell")));

        // The cell's directory carries its placed reference: a batch that kept only the cell's own
        // document would restore the record and lose everything beneath it.
        Assert.Contains(cell.ToString(), refusal.Message, StringComparison.Ordinal);
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }

    // The put the repository would answer by minting a directory and the block levels above it —
    // more than the one document's bytes a batch entry holds.
    [Fact]
    public void ABatchAskedToPutAContainerTheTreeDoesNotHold_RefusesBeforeTouchingTheTree()
    {
        var repository = Track(_firstFolder, "First.esp");
        var plugin = new PluginKey("First.esp", "FirstMod");
        var before = TreeSnapshot.Of(_firstFolder);

        var transaction = new SourceTransaction();
        var refusal = Assert.Throws<NotSupportedException>(() => transaction.Put(
            repository, plugin,
            new SourceDocument("000900:First.esp", "cell", "FreshCell", "{\n  \"FormKey\": \"000900:First.esp\"\n}")));

        Assert.Contains("000900:First.esp", refusal.Message, StringComparison.Ordinal);
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }

    [Fact]
    public void ABatchWhoseRemoveFollowsAPut_PutsBothBackOnRollback()
    {
        var repository = Track(_firstFolder, "First.esp");
        var plugin = new PluginKey("First.esp", "FirstMod");
        var before = TreeSnapshot.Of(_firstFolder);

        var transaction = new SourceTransaction();
        // A sibling in the group folder Track already made, so nothing here mints a directory.
        transaction.Put(
            repository, plugin,
            new SourceDocument("000900:First.esp", "npc_", "Sibling", "{\n  \"FormKey\": \"000900:First.esp\"\n}"));
        Assert.Equal(
            SourceRemoval.Removed,
            transaction.Remove(repository, plugin, new RecordIdentity("000800:First.esp", "npc_", "Original")));

        Assert.NotEqual(before, TreeSnapshot.Of(_firstFolder));
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_firstFolder));
    }
}
