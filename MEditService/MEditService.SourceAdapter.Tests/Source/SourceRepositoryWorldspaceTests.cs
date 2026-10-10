using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryWorldspaceTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string PluginName = "Vendor.esp";
    private const string Worldspace = "000800:Vendor.esp";
    private const string ExteriorCell = "000801:Vendor.esp";
    private const string InteriorCell = "000802:Vendor.esp";

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);

    private readonly ScratchDirectory _modFolder = new("medit-worldspace-");

    public void Dispose() => _modFolder.Dispose();

    private ISourceRepository Repository => TestAdapters.Source().OverFolder(TestMod.In(_modFolder), Release);

    private static string Body(string formKey, string? grid = null) =>
        grid == null
            ? $"{{\n  \"FormKey\": \"{formKey}\"\n}}"
            : $"{{\n  \"FormKey\": \"{formKey}\",\n  \"Grid\": {{\n    \"Point\": \"{grid}\"\n  }}\n}}";

    private SourceDocument InTheTree(string formKey, string recordType, string? grid = null)
    {
        var document = new SourceDocument(formKey, recordType, EditorId: null, Body(formKey, grid));
        Repository.Put(Plugin, document).Wrote();
        return document;
    }

    private static SourceDocument ACellAt(string grid, string formKey = ExteriorCell) =>
        new(formKey, "cell", EditorId: null, Body(formKey, grid));

    private IReadOnlyList<string> Documents() =>
        Directory.EnumerateFiles(_modFolder, "*.json", SearchOption.AllDirectories)
            .Where(file => !file.EndsWith("GroupRecordData.json", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(_modFolder, file))
            .Order(StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void PutInWorldspace_ACell_LandsInTheBlockItsGridFallsIn()
    {
        InTheTree(Worldspace, "wrld");

        Repository.PutInWorldspace(Plugin, ACellAt("9, -9"), Worldspace);

        Assert.Contains(
            PluginSourceRoot.ContainerDocument(Path.Combine(
                "plugin-source", PluginName, "Worldspaces", "000800_Vendor.esp", "0, -1", "1, -2",
                "000801_Vendor.esp")),
            Documents());
    }

    [Fact]
    public void PutInWorldspace_ACellWithNoGrid_HasNoPlace_AndInventsNoFile()
    {
        InTheTree(Worldspace, "wrld");
        var before = Documents();

        var refused = Assert.Throws<InvalidOperationException>(
            () => Repository.PutInWorldspace(Plugin, new SourceDocument(ExteriorCell, "cell", null, Body(ExteriorCell)), Worldspace));

        Assert.Contains(ExteriorCell, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Documents());
    }

    [Fact]
    public void GetCellAt_AGridWithACell_IsThatCellsDocument()
    {
        InTheTree(Worldspace, "wrld");
        var cell = ACellAt("9, -9");
        Repository.PutInWorldspace(Plugin, cell, Worldspace);

        Assert.Equal(cell.Body, Repository.GetCellAt(Plugin, Worldspace, 9, -9).Value()?.Body);
    }

    [Fact]
    public void GetCellAt_AGridNoCellHolds_IsNull()
    {
        InTheTree(Worldspace, "wrld");
        Repository.PutInWorldspace(Plugin, ACellAt("9, -9"), Worldspace);

        Assert.Null(Repository.GetCellAt(Plugin, Worldspace, 10, -9).Value());
    }

    private static string WorldspaceDocument =>
        PluginSourceRoot.ContainerDocument(Path.Combine("plugin-source", PluginName, "Worldspaces", "000800_Vendor.esp"));

    private static string CellDocumentAtNineMinusNine =>
        PluginSourceRoot.ContainerDocument(Path.Combine(
            "plugin-source", PluginName, "Worldspaces", "000800_Vendor.esp", "0, -1", "1, -2", "000801_Vendor.esp"));

    [Fact]
    public void GetCellAt_AGridWhoseCellDocumentRootIsNotAnObject_RefusesNamingThatFile()
    {
        InTheTree(Worldspace, "wrld");
        Repository.PutInWorldspace(Plugin, ACellAt("9, -9"), Worldspace);
        File.WriteAllText(Path.Combine(_modFolder, CellDocumentAtNineMinusNine), "[]");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.GetCellAt(Plugin, Worldspace, 9, -9).Stopped());

        Assert.Equal(CellDocumentAtNineMinusNine, refused.File?.SourceRelativePath);
        Assert.Contains("its root is not a JSON object", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void GetCellAt_AGridWhoseCellDocumentIsNoJson_RefusesNamingThatFile()
    {
        InTheTree(Worldspace, "wrld");
        Repository.PutInWorldspace(Plugin, ACellAt("9, -9"), Worldspace);
        File.WriteAllText(Path.Combine(_modFolder, CellDocumentAtNineMinusNine), "{");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.GetCellAt(Plugin, Worldspace, 9, -9).Stopped());

        Assert.Equal(CellDocumentAtNineMinusNine, refused.File?.SourceRelativePath);
    }

    [Fact]
    public void WorldspaceOf_AnExteriorCellWhoseWorldspaceDeclaresNoFormKey_RefusesNamingTheWorldspacesFile()
    {
        InTheTree(Worldspace, "wrld");
        var cell = ACellAt("9, -9");
        Repository.PutInWorldspace(Plugin, cell, Worldspace);
        File.WriteAllText(Path.Combine(_modFolder, WorldspaceDocument), "{}");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.WorldspaceOf(Plugin, cell.Identity).Stopped());

        Assert.Equal(WorldspaceDocument, refused.File?.SourceRelativePath);
    }

    [Fact]
    public void WorldspaceOf_AnExteriorCell_IsTheWorldspaceItSitsIn()
    {
        InTheTree(Worldspace, "wrld");
        var cell = ACellAt("9, -9");
        Repository.PutInWorldspace(Plugin, cell, Worldspace);

        Assert.Equal(Worldspace, Repository.WorldspaceOf(Plugin, cell.Identity).Value());
    }

    [Fact]
    public void WorldspaceOf_AnInteriorCell_IsNull()
    {
        var cell = InTheTree(InteriorCell, "cell");

        Assert.Null(Repository.WorldspaceOf(Plugin, cell.Identity).Value());
    }

    [Fact]
    public void WorldspaceOf_ACellTheTreeFilesUnderNeitherAGroupNorAWorldspace_RefusesWithTheReadersWords()
    {
        var cell = InTheTree(InteriorCell, "cell");
        var cells = Path.Combine(_modFolder, "plugin-source", PluginName, "Cells");
        Directory.Move(Path.Combine(cells, "0", "5", "000802_Vendor.esp"), Path.Combine(cells, "000802_Vendor.esp"));

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.WorldspaceOf(Plugin, cell.Identity).Stopped());

        Assert.Contains(InteriorCell, refused.Reason, StringComparison.Ordinal);
    }
}
