using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreateCellInWorldspaceTests : IDisposable
{
    private static readonly FormKey World = new(Fallout4Esm, 0x900);
    private static readonly FormKey MasterCell = new(Fallout4Esm, 0x902);
    private static readonly FormKey PartialFormOverride = new(Fallout4Esm, 0x903);

    private readonly LoadOrderOfPlugins _plugins = new();
    private readonly Fallout4Mod _master;
    private readonly Fallout4Mod _edited;
    private readonly FormKey _ownCell;

    public CreateCellInWorldspaceTests()
    {
        _master = Plugin("Fallout4.esm", mod =>
        {
            var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(MasterCell, Fallout4Release.Fallout4) { EditorID = "MasterCell", Grid = new CellGrid { Point = new P2Int(3, 3) } }));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(PartialFormOverride, Fallout4Release.Fallout4) { Grid = new CellGrid { Point = new P2Int(40, 40) } }));
            mod.Worldspaces.Add(world);
        });
        _edited = Plugin("Override.esp", mod =>
        {
            var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
            var own = new Cell(mod) { EditorID = "OwnCell", Grid = new CellGrid { Point = new P2Int(5, 6) } };
            world.SubCells.Add(CellBlocks.Exterior(own));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(PartialFormOverride, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = PartialFormFlag.Bit }));
            mod.Worldspaces.Add(world);
        });
        _ownCell = _edited.Worldspaces[World].SubCells
            .SelectMany(block => block.Items).SelectMany(subBlock => subBlock.Items).Single(cell => cell.EditorID == "OwnCell").FormKey;
        _plugins.Load((_master, false), (_edited, true));
    }

    public void Dispose() => _plugins.Dispose();

    private PluginAddress Edited => Address(_edited);

    private IReadOnlyList<string> Tree => SourceModTree.Records(_plugins.FolderOf(_edited), Edited);

    private RecordEditResult CreateCellAt(int? x, int? y) =>
        _plugins.CreateHandler.CreateRecordSync(Edited, "cell", World.ToString(), new GridPosition(x, y));

    [Fact]
    public void ACellCreatedOnAWorldspace_LandsAtItsGrid_InTheBlockAndSubBlockItFallsIn_UnderTheKeyAfterTheHighestOfThePluginsOwnRecords()
    {
        var result = CreateCellAt(-9, 33);

        Assert.True(result.Applied, result.Message);
        var created = result.NewFormKey.Require();
        Assert.Equal("000801:Override.esp", created);
        var cell = Document.Parse(SourceModTree.Body(_plugins.FolderOf(_edited), Edited, created));
        Assert.Equal((-9, 33), cell.Grid);
        Assert.False(PlacedCell.IsInterior(cell));
        var file = SourceModTree.DocumentFile(_plugins.FolderOf(_edited), Edited, created).Require();
        Assert.Contains(
            Path.DirectorySeparatorChar + Path.Combine("-1, 1", "-2, 4") + Path.DirectorySeparatorChar, file, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(5, 6, "Override.esp already holds the cell 000800:Override.esp", false)]
    [InlineData(40, 40, "Override.esp already holds the cell 000903:Fallout4.esm", false)]
    [InlineData(3, 3, "000902:Fallout4.esm", true)]
    public void ACellCreatedWhereTheCellAtItsGridIsHeld_IsRefusedNamingTheHolder_PointingAtCopyAsOverrideOnlyWhereAMasterHoldsIt_AndWritesNothing(
        int x, int y, string named, bool pointsAtCopy)
    {
        var before = Tree;

        var result = CreateCellAt(x, y);

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains(named, result.Message, StringComparison.Ordinal);
        Assert.Equal(pointsAtCopy, result.Message.Contains("Copying the record as an override", StringComparison.Ordinal));
        Assert.Equal(before, Tree);
    }

    [Fact]
    public void ACellCreatedOnAWorldspaceWithOneCoordinate_IsRefusedAsAMalformedEnvelope_AndWritesNothing()
    {
        var before = Tree;

        var result = CreateCellAt(1, null);

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Equal(before, Tree);
    }

    [Fact]
    public void ACellCreatedBesideACellDocumentThatIsNoJson_IsRefusedAsUnreadable_AndWritesNothing()
    {
        _plugins.Respell(_edited, _ownCell, "cell", "{", "[");
        var before = Files;

        var result = CreateCellAt(5, 7);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(1, Regex.Count(result.Message, Regex.Escape(World.ToString())));
        Assert.EndsWith("Nothing was written.", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, Files);
    }

    private List<string> Files =>
        [.. Directory.GetFiles(_plugins.FolderOf(_edited), "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)];
}
