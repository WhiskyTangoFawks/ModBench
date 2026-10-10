using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryPlacementTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Vendor.esp";
    private const string FormKey = "000800:Vendor.esp";

    private static readonly PluginAddress Key = new(Plugin, TestMod.Name);

    private readonly ScratchDirectory _modFolder = new("medit-placement-");

    public void Dispose() => _modFolder.Dispose();

    private ISourceRepository RepositoryOverATreeWithNoGit => TestAdapters.Source().OverFolder(TestMod.In(_modFolder), Release);

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
            [PluginSourceRoot.ContainerDocument(SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp"))],
            TreeAfterPutting("wrld", "SomeWorld"));
    }

    [Fact]
    public void AnInteriorCell_LandsInTheBlockAndSubBlockItsFormIdGives_MintingBothWithTheirNumbers()
    {
        Assert.Equal(
            [
                SpelledOutPathUnder("Cells", "8", "4", "GroupRecordData.json"),
                PluginSourceRoot.ContainerDocument(SpelledOutPathUnder("Cells", "8", "4", "SomeCell - 000800_Vendor.esp")),
                SpelledOutPathUnder("Cells", "8", "GroupRecordData.json"),
                SpelledOutPathUnder("Cells", "GroupRecordData.json"),
            ],
            TreeAfterPutting("cell", "SomeCell"));

        Assert.Contains("\"BlockNumber\": 8", Text(SpelledOutPathUnder("Cells", "8", "GroupRecordData.json")));
        Assert.Contains("\"BlockNumber\": 4", Text(SpelledOutPathUnder("Cells", "8", "4", "GroupRecordData.json")));
    }

    [Fact]
    public void AnInteriorCell_LandsInTheLevelsItsFormIdGives_NotInOnesTheTreeAlreadyHolds()
    {
        TreeAfterPutting("cell", "SomeCell");

        var tree = TreeAfterPutting("cell", "SameBlockCell", formKey: "000864:Vendor.esp");
        Assert.Contains(
            PluginSourceRoot.ContainerDocument(SpelledOutPathUnder("Cells", "8", "4", "SameBlockCell - 000864_Vendor.esp")), tree);

        tree = TreeAfterPutting("cell", "OtherCell", formKey: "000808:Vendor.esp");
        Assert.Contains(
            PluginSourceRoot.ContainerDocument(SpelledOutPathUnder("Cells", "6", "5", "OtherCell - 000808_Vendor.esp")), tree);
    }

    [Fact]
    public void AnInteriorCellInABlockTheTreeHolds_MintsOnlyItsMissingSubBlock()
    {
        TreeAfterPutting("cell", "SomeCell");
        var standing = Text(SpelledOutPathUnder("Cells", "8", "GroupRecordData.json"));

        var tree = TreeAfterPutting("cell", "OtherCell", formKey: "00080A:Vendor.esp");

        Assert.Contains(
            PluginSourceRoot.ContainerDocument(SpelledOutPathUnder("Cells", "8", "5", "OtherCell - 00080A_Vendor.esp")), tree);
        Assert.Contains("\"BlockNumber\": 5", Text(SpelledOutPathUnder("Cells", "8", "5", "GroupRecordData.json")));
        Assert.Equal(standing, Text(SpelledOutPathUnder("Cells", "8", "GroupRecordData.json")));
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

    private const string Somewhere = "9, -9";

    private IReadOnlyList<string> TreeAfterPuttingExteriorCell(
        string grid, string? editorId = "SomeCell", string formKey = CellFormKey)
    {
        RepositoryOverATreeWithNoGit.PutInWorldspace(
            Key, new SourceDocument(formKey, "cell", editorId, GridBody(formKey, editorId, grid)), WorldspaceFormKey);

        return Documents();
    }

    private static string GridBody(string formKey, string? editorId, string grid) =>
        $"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\",\n  \"Grid\": {{\n    \"Point\": \"{grid}\"\n  }}\n}}";

    private string Text(string relativePath) => File.ReadAllText(Path.Combine(_modFolder, relativePath));

    [Fact]
    public void AnExteriorCell_LandsUnderTwoBlockLevelsInsideItsWorldspacesOwnDirectory()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");

        Assert.Equal(
            new[]
            {
                PluginSourceRoot.ContainerDocument(worldspace),
                Path.Combine(worldspace, "0, -1", "GroupRecordData.json"),
                Path.Combine(worldspace, "0, -1", "1, -2", "GroupRecordData.json"),
                PluginSourceRoot.ContainerDocument(Path.Combine(worldspace, "0, -1", "1, -2", "SomeCell - 000801_Vendor.esp")),
            }.Order(StringComparer.Ordinal),
            TreeAfterPuttingExteriorCell(Somewhere));
    }

    [Fact]
    public void AMintedBlockLevel_CarriesTheNumbersTheGridPlacesItAt()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        TreeAfterPuttingExteriorCell(Somewhere);
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");

        Assert.Equal(
            "{\n  \"BlockNumberY\": -1\n}",
            Text(Path.Combine(worldspace, "0, -1", "GroupRecordData.json")));
        Assert.Equal(
            "{\n  \"BlockNumberY\": -2,\n  \"BlockNumberX\": 1\n}",
            Text(Path.Combine(worldspace, "0, -1", "1, -2", "GroupRecordData.json")));
    }

    [Fact]
    public void AnExteriorCellsBlockLevels_AreNamedFromItsGrid_ASubBlockEightCellsASideAndABlockFourSubBlocks()
    {
        TreeAfterPutting("wrld", "SomeWorld");

        Assert.Contains(
            PluginSourceRoot.ContainerDocument(SpelledOutPathUnder(
                "Worldspaces", "SomeWorld - 000800_Vendor.esp", "1, -1", "4, -3",
                "SomeCell - 000801_Vendor.esp")),
            TreeAfterPuttingExteriorCell("33, -20"));
    }

    [Fact]
    public void ABlockLevelTheTreeAlreadyHolds_KeepsItsOwnDocument()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");
        var standing = Path.Combine(worldspace, "0, -1", "GroupRecordData.json");
        const string HandWritten = "{\n  \"BlockNumberY\": -1,\n  \"Timestamp\": 7\n}";

        Directory.CreateDirectory(Path.Combine(_modFolder, worldspace, "0, -1"));
        File.WriteAllText(Path.Combine(_modFolder, standing), HandWritten);

        TreeAfterPuttingExteriorCell(Somewhere);

        Assert.Equal(HandWritten, Text(standing));
    }

    [Fact]
    public void ASecondExteriorCell_LandsInsideTheStandingWorldspace_AndLeavesItsOwnDocumentAlone()
    {
        TreeAfterPutting("wrld", "SomeWorld");
        var worldspace = SpelledOutPathUnder("Worldspaces", "SomeWorld - 000800_Vendor.esp");
        var before = Text(PluginSourceRoot.ContainerDocument(worldspace));

        TreeAfterPuttingExteriorCell(Somewhere);
        var tree = TreeAfterPuttingExteriorCell(Somewhere, "OtherCell", "000802:Vendor.esp");

        Assert.Equal(before, Text(PluginSourceRoot.ContainerDocument(worldspace)));
        Assert.Single(Directory.EnumerateDirectories(Path.Combine(_modFolder, SpelledOutPathUnder("Worldspaces"))));
        Assert.Contains(
            PluginSourceRoot.ContainerDocument(Path.Combine(worldspace, "0, -1", "1, -2", "OtherCell - 000802_Vendor.esp")), tree);
        Assert.Contains(
            PluginSourceRoot.ContainerDocument(Path.Combine(worldspace, "0, -1", "1, -2", "SomeCell - 000801_Vendor.esp")), tree);
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
