using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The whole taxonomy, asserted on the tree a put leaves behind: a flat record (a quest
/// included) is a file in its group folder, a container a directory there, an interior Cell a
/// directory under a block pair.</summary>
public sealed class SourceRepositoryPlacementTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";
    private const string FormKey = "000800:Vendor.esp";

    private static readonly PluginKey Key = new(Plugin);

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-placement-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    // Over rather than Open: placement is a document verb, and a tree with no .git answers every one
    // of them.
    private IReadOnlyList<string> TreeAfterPutting(string recordType, string? editorId, string formKey = FormKey)
    {
        SourceRepository.Over(_modFolder, Release)
            .Put(Key, new SourceDocument(formKey, recordType, editorId, Body(formKey, editorId)));

        return Documents();
    }

    private IReadOnlyList<string> Documents() =>
        Directory.EnumerateFiles(_modFolder, "*.json", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(_modFolder, f))
            .Order(StringComparer.Ordinal)
            .ToList();

    // Spelled out rather than asked of the repository: these are the paths the layout promises, and
    // asking would only echo the rule under test back at it.
    private static string Under(params string[] segments) => Path.Combine(["source", Plugin, .. segments]);

    private static string Body(string formKey, string? editorId) =>
        editorId == null
            ? $"{{\n  \"FormKey\": \"{formKey}\"\n}}"
            : $"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    [Fact]
    public void AFlatRecord_LandsAsAFileInItsGroupFolder()
    {
        Assert.Equal(
            [Under("Npcs", "SomeNpc - 000800_Vendor.esp.json")],
            TreeAfterPutting("npc_", "SomeNpc"));
    }

    [Fact]
    public void AQuest_LandsAsAFileInItsGroupFolder()
    {
        Assert.Equal(
            [Under("Quests", "SomeQuest - 000800_Vendor.esp.json")],
            TreeAfterPutting("Quest", "SomeQuest"));
    }

    [Fact]
    public void ADirectoryPerRecordContainer_LandsAsADirectoryInItsGroupFolder()
    {
        Assert.Equal(
            [Under("Worldspaces", "SomeWorld - 000800_Vendor.esp", "RecordData.json")],
            TreeAfterPutting("wrld", "SomeWorld"));
    }

    [Fact]
    public void AnInteriorCell_LandsUnderAFreshlyMintedBlockPair()
    {
        Assert.Equal(
            [
                Under("Cells", "0", "0", "GroupRecordData.json"),
                Under("Cells", "0", "0", "SomeCell - 000800_Vendor.esp", "RecordData.json"),
                Under("Cells", "0", "GroupRecordData.json"),
                Under("Cells", "GroupRecordData.json"),
            ],
            TreeAfterPutting("cell", "SomeCell"));
    }

    // The second cell reuses the first's bucket rather than minting a second: interior block numbers
    // carry no gameplay meaning, so one bucket per plugin is as true as any other.
    [Fact]
    public void AnInteriorCell_LandsInTheBlockBucketThePluginAlreadyHas()
    {
        TreeAfterPutting("cell", "SomeCell");
        Directory.Move(
            Path.Combine(_modFolder, Under("Cells", "0")),
            Path.Combine(_modFolder, Under("Cells", "7")));

        Assert.Contains(
            Under("Cells", "7", "0", "OtherCell - 000801_Vendor.esp", "RecordData.json"),
            TreeAfterPutting("cell", "OtherCell", formKey: "000801:Vendor.esp"));
    }

    [Fact]
    public void ARecordWithNoEditorId_IsNamedByItsFormKeyAlone()
    {
        Assert.Equal(
            [Under("Npcs", "000800_Vendor.esp.json")],
            TreeAfterPutting("npc_", editorId: null));
    }

    // A child has no document of its own, so a put with no container to splice it into has nowhere to
    // write and says so rather than inventing a file.
    [Fact]
    public void AnEmbeddedChild_HasNoPlaceOfItsOwn()
    {
        var refused = Assert.Throws<InvalidOperationException>(
            () => TreeAfterPutting("dial", "SomeTopic", formKey: "000801:Vendor.esp"));

        Assert.Contains("nowhere to write it", refused.Message, StringComparison.Ordinal);
        Assert.Empty(Documents());
    }
}
