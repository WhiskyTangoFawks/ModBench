using MEditService.Codec.Schema;
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

    private static readonly PluginAddress Plugin = new(PluginName, "VendorMod");
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas = SharedSchemaReflector.Instance.GetSchemas(Release);

    private readonly ScratchDirectory _modFolder = new("medit-worldspace-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Repository => SourceRepository.Over(TestMod.In(_modFolder), Release);

    private static string Body(string formKey, string? grid = null) =>
        grid == null
            ? $"{{\n  \"FormKey\": \"{formKey}\"\n}}"
            : $"{{\n  \"FormKey\": \"{formKey}\",\n  \"Grid\": {{\n    \"Point\": \"{grid}\"\n  }}\n}}";

    private SourceDocument InTheTree(string formKey, string recordType, string? grid = null)
    {
        var document = new SourceDocument(formKey, recordType, EditorId: null, Body(formKey, grid));
        Repository.Put(Plugin, document);
        return document;
    }

    private static SourceDocument ACellAt(string grid, string formKey = ExteriorCell) =>
        new(formKey, "cell", EditorId: null, Body(formKey, grid));

    private IReadOnlyList<string> Documents() =>
        Directory.EnumerateFiles(_modFolder, "RecordData.json", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_modFolder, file))
            .Order(StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void PutInWorldspace_ACell_LandsInTheBlockItsGridFallsIn()
    {
        InTheTree(Worldspace, "wrld");

        Repository.PutInWorldspace(Plugin, ACellAt("9, -9"), Worldspace);

        Assert.Contains(
            Path.Combine(
                "plugin-source", PluginName, "Worldspaces", "000800_Vendor.esp", "0, -1", "1, -2",
                "000801_Vendor.esp", "RecordData.json"),
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
    public void PutInWorldspace_ThroughATransaction_IsTakenBackByItsRollback()
    {
        InTheTree(Worldspace, "wrld");
        var before = TreeSnapshot.Of(_modFolder);

        var transaction = new SourceTransaction();
        transaction.PutInWorldspace(Repository, Plugin, ACellAt("9, -9"), Worldspace);

        Assert.NotEqual(before, TreeSnapshot.Of(_modFolder));
        Assert.Empty(transaction.Undo(Repository));
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void GetCellAt_AGridWithACell_IsThatCellsDocument()
    {
        InTheTree(Worldspace, "wrld");
        var cell = ACellAt("9, -9");
        Repository.PutInWorldspace(Plugin, cell, Worldspace);

        Assert.Equal(cell.Body, Repository.GetCellAt(Plugin, Worldspace, 9, -9, Schemas)?.Body);
    }

    [Fact]
    public void GetCellAt_AGridNoCellHolds_IsNull()
    {
        InTheTree(Worldspace, "wrld");
        Repository.PutInWorldspace(Plugin, ACellAt("9, -9"), Worldspace);

        Assert.Null(Repository.GetCellAt(Plugin, Worldspace, 10, -9, Schemas));
    }

    [Fact]
    public void WorldspaceOf_AnExteriorCell_IsTheWorldspaceItSitsIn()
    {
        InTheTree(Worldspace, "wrld");
        var cell = ACellAt("9, -9");
        Repository.PutInWorldspace(Plugin, cell, Worldspace);

        Assert.Equal(Worldspace, Repository.WorldspaceOf(Plugin, cell.Identity));
    }

    [Fact]
    public void WorldspaceOf_AnInteriorCell_IsNull()
    {
        var cell = InTheTree(InteriorCell, "cell");

        Assert.Null(Repository.WorldspaceOf(Plugin, cell.Identity));
    }

    [Fact]
    public void WorldspaceOf_ACellTheTreeFilesUnderNeitherAGroupNorAWorldspace_RefusesWithTheReadersWords()
    {
        var cell = InTheTree(InteriorCell, "cell");
        var cells = Path.Combine(_modFolder, "plugin-source", PluginName, "Cells");
        Directory.Move(Path.Combine(cells, "0", "0", "000802_Vendor.esp"), Path.Combine(cells, "000802_Vendor.esp"));

        var refused = Assert.Throws<UnreadableSourceDocumentException>(() => Repository.WorldspaceOf(Plugin, cell.Identity));

        Assert.Contains(InteriorCell, refused.Message, StringComparison.Ordinal);
    }
}
