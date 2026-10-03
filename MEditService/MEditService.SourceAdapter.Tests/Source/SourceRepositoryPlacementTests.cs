using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryPlacementTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";
    private const string FormKey = "000800:Vendor.esp";

    private static readonly PluginAddress Key = new(Plugin, "VendorMod");

    private readonly ScratchDirectory _modFolder = new("medit-placement-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository RepositoryOverATreeWithNoGit => SourceRepository.Over(_modFolder, Release);

    private IReadOnlyList<string> TreeAfterPutting(string recordType, string? editorId, string formKey = FormKey)
    {
        RepositoryOverATreeWithNoGit
            .Put(Key, new SourceDocument(formKey, recordType, editorId, Body(formKey, editorId)));

        return Documents();
    }

    private IReadOnlyList<string> Documents() =>
        Directory.EnumerateFiles(_modFolder, "*.json", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(_modFolder, f))
            .Order(StringComparer.Ordinal)
            .ToList();

    private static string SpelledOutPathUnder(params string[] segments) => Path.Combine(["plugin-source", Plugin, .. segments]);

    private static string Body(string formKey, string? editorId) =>
        editorId == null
            ? $"{{\n  \"FormKey\": \"{formKey}\"\n}}"
            : $"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    [Fact]
    public void AFlatRecord_LandsAsAFileInItsGroupFolder()
    {
        Assert.Equal(
            [SpelledOutPathUnder("Npcs", "SomeNpc - 000800_Vendor.esp.json")],
            TreeAfterPutting("npc_", "SomeNpc"));
    }

    [Fact]
    public void AQuest_LandsAsAFileInItsGroupFolder()
    {
        Assert.Equal(
            [SpelledOutPathUnder("Quests", "SomeQuest - 000800_Vendor.esp.json")],
            TreeAfterPutting("Quest", "SomeQuest"));
    }

    [Fact]
    public void ADirectoryPerRecordContainer_LandsAsADirectoryInItsGroupFolder()
    {
        Assert.Equal(
            [SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp", "RecordData.json")],
            TreeAfterPutting("wrld", "SomeWorld"));
    }

    [Fact]
    public void AnInteriorCell_LandsUnderAFreshlyMintedBlockPair()
    {
        Assert.Equal(
            [
                SpelledOutPathUnder("Cells", "0", "0", "GroupRecordData.json"),
                SpelledOutPathUnder("Cells", "0", "0", "SomeCell - 000800_Vendor.esp", "RecordData.json"),
                SpelledOutPathUnder("Cells", "0", "GroupRecordData.json"),
                SpelledOutPathUnder("Cells", "GroupRecordData.json"),
            ],
            TreeAfterPutting("cell", "SomeCell"));
    }

    [Fact]
    public void AnInteriorCell_LandsInTheBlockBucketThePluginAlreadyHas_ForInteriorBlockNumbersCarryNoGameplayMeaning()
    {
        TreeAfterPutting("cell", "SomeCell");
        Directory.Move(
            Path.Combine(_modFolder, SpelledOutPathUnder("Cells", "0")),
            Path.Combine(_modFolder, SpelledOutPathUnder("Cells", "7")));

        Assert.Contains(
            SpelledOutPathUnder("Cells", "7", "0", "OtherCell - 000801_Vendor.esp", "RecordData.json"),
            TreeAfterPutting("cell", "OtherCell", formKey: "000801:Vendor.esp"));
    }

    [Fact]
    public void ARecordWithNoEditorId_IsNamedByItsFormKeyAlone()
    {
        Assert.Equal(
            [SpelledOutPathUnder("Npcs", "000800_Vendor.esp.json")],
            TreeAfterPutting("npc_", editorId: null));
    }

    private const string WorldspaceFormKey = FormKey;
    private const string CellFormKey = "000801:Vendor.esp";

    private static readonly CellPlacement Somewhere =
        new(WorldspaceFormKey, BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, IsInterior: false);

    private IReadOnlyList<string> TreeAfterPuttingExteriorCell(
        CellPlacement placement, string? editorId = "SomeCell", string formKey = CellFormKey)
    {
        RepositoryOverATreeWithNoGit
            .Put(Key, new SourceDocument(formKey, "cell", editorId, Body(formKey, editorId)), placement);

        return Documents();
    }

    private string Text(string relativePath) => File.ReadAllText(Path.Combine(_modFolder, relativePath));

    [Fact]
    public void AnExteriorCell_LandsUnderTwoBlockLevelsInsideItsWorldspacesOwnDirectory()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");

        Assert.Equal(
            new[]
            {
                Path.Combine(worldspace, "RecordData.json"),
                Path.Combine(worldspace, "3, -2", "GroupRecordData.json"),
                Path.Combine(worldspace, "3, -2", "0, -1", "GroupRecordData.json"),
                Path.Combine(worldspace, "3, -2", "0, -1", "SomeCell - 000801_Vendor.esp", "RecordData.json"),
            }.Order(StringComparer.Ordinal),
            TreeAfterPuttingExteriorCell(Somewhere));
    }

    [Fact]
    public void AMintedBlockLevel_CarriesThePlacementsOwnNumbers()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        TreeAfterPuttingExteriorCell(Somewhere);
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");

        Assert.Equal(
            "{\n  \"BlockNumberY\": -2,\n  \"BlockNumberX\": 3\n}",
            Text(Path.Combine(worldspace, "3, -2", "GroupRecordData.json")));
        Assert.Equal(
            "{\n  \"BlockNumberY\": -1\n}",
            Text(Path.Combine(worldspace, "3, -2", "0, -1", "GroupRecordData.json")));
    }

    [Fact]
    public void AnExteriorCellsBlockLevels_AreNamedFromThePlacementsOwnNumbers_NotDerived()
    {
        TreeAfterPutting("wrld", "SomeWorld");

        Assert.Contains(
            SpelledOutPathUnder(
                "Worldspaces", "SomeWorld - 000800_Vendor.esp", "-7, 11", "4, -3",
                "SomeCell - 000801_Vendor.esp", "RecordData.json"),
            TreeAfterPuttingExteriorCell(
                new CellPlacement(WorldspaceFormKey, BlockX: -7, BlockY: 11, SubX: 4, SubY: -3, IsInterior: false)));
    }

    [Fact]
    public void ABlockLevelTheTreeAlreadyHolds_KeepsItsOwnDocument()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");
        var standing = Path.Combine(worldspace, "3, -2", "GroupRecordData.json");
        const string HandWritten = "{\n  \"BlockNumberY\": -2,\n  \"BlockNumberX\": 3,\n  \"Timestamp\": 7\n}";

        Directory.CreateDirectory(Path.Combine(_modFolder, worldspace, "3, -2"));
        File.WriteAllText(Path.Combine(_modFolder, standing), HandWritten);

        TreeAfterPuttingExteriorCell(Somewhere);

        Assert.Equal(HandWritten, Text(standing));
    }

    [Fact]
    public void ASecondExteriorCell_LandsInsideTheStandingWorldspace_AndLeavesItsOwnDocumentAlone()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");
        var before = Text(Path.Combine(worldspace, "RecordData.json"));

        TreeAfterPuttingExteriorCell(Somewhere);
        var tree = TreeAfterPuttingExteriorCell(Somewhere, "OtherCell", "000802:Vendor.esp");

        Assert.Equal(before, Text(Path.Combine(worldspace, "RecordData.json")));
        Assert.Single(Directory.EnumerateDirectories(Path.Combine(_modFolder, SpelledOutPathUnder("Worldspaces"))));
        Assert.Contains(
            Path.Combine(worldspace, "3, -2", "0, -1", "OtherCell - 000802_Vendor.esp", "RecordData.json"), tree);
        Assert.Contains(
            Path.Combine(worldspace, "3, -2", "0, -1", "SomeCell - 000801_Vendor.esp", "RecordData.json"), tree);
    }

    [Fact]
    public void AnExteriorCell_WhoseWorldspaceTheTreeDoesNotHold_HasNoPlaceOfItsOwn()
    {
        var refused = Assert.Throws<InvalidOperationException>(() => TreeAfterPuttingExteriorCell(Somewhere));

        Assert.Contains(WorldspaceFormKey, refused.Message, StringComparison.Ordinal);
        Assert.Empty(Documents());
    }

    [Fact]
    public void AnEmbeddedChild_PutWithNoContainerToSpliceItInto_HasNoPlaceOfItsOwn_AndInventsNoFile()
    {
        var refused = Assert.Throws<InvalidOperationException>(
            () => TreeAfterPutting("dial", "SomeTopic", formKey: "000801:Vendor.esp"));

        Assert.Contains("nowhere to write it", refused.Message, StringComparison.Ordinal);
        Assert.Empty(Documents());
    }
}
