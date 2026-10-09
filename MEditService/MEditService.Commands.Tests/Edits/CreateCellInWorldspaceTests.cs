using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
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
    private static readonly FormKey MovedOverride = new(Fallout4Esm, 0x904);

    private readonly LoadOrderOfPlugins _plugins = new();
    private readonly Fallout4Mod _master;
    private readonly Fallout4Mod _edited;
    private readonly FormKey _ownCell;
    private readonly FormKey _deletedWorld;

    public CreateCellInWorldspaceTests()
    {
        _master = Plugin("Fallout4.esm", mod =>
        {
            var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(MasterCell, Fallout4Release.Fallout4) { EditorID = "MasterCell", Grid = new CellGrid { Point = new P2Int(3, 3) } }));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(PartialFormOverride, Fallout4Release.Fallout4) { Grid = new CellGrid { Point = new P2Int(40, 40) } }));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(MovedOverride, Fallout4Release.Fallout4) { Grid = new CellGrid { Point = new P2Int(-40, -40) } }));
            mod.Worldspaces.Add(world);
        });
        _edited = Plugin("Override.esp", mod =>
        {
            var world = new Worldspace(World, Fallout4Release.Fallout4) { EditorID = "World" };
            var own = new Cell(mod) { EditorID = "OwnCell", Grid = new CellGrid { Point = new P2Int(5, 6) } };
            world.SubCells.Add(CellBlocks.Exterior(own));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(PartialFormOverride, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = PartialFormFlag.Bit }));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(MovedOverride, Fallout4Release.Fallout4) { Grid = new CellGrid { Point = new P2Int(-60, -60) } }));
            mod.Worldspaces.Add(world);
            mod.Worldspaces.Add(new Worldspace(mod) { EditorID = "DeletedWorld", MajorRecordFlagsRaw = DeletedFlag.Bit });
        });
        _ownCell = _edited.Worldspaces[World].SubCells
            .SelectMany(block => block.Items).SelectMany(subBlock => subBlock.Items).Single(cell => cell.EditorID == "OwnCell").FormKey;
        _deletedWorld = _edited.Worldspaces.Single(world => world.EditorID == "DeletedWorld").FormKey;
        _plugins.Load((_master, true), (_edited, true));
    }

    public void Dispose() => _plugins.Dispose();

    private PluginAddress Edited => Address(_edited);

    private IReadOnlyList<string> Tree => TrackedTree.Records(_plugins.FolderOf(_edited), Edited);

    private RecordEditResult CreateCellAt(int? x, int? y) =>
        _plugins.CreateHandler.CreateRecordSync(Edited, "cell", World.ToString(), new GridPosition(x, y));

    [Theory]
    [InlineData(-9, 33, "-1, 1", "-2, 4")]
    [InlineData(0, 0, "0, 0", "0, 0")]
    [InlineData(32, -1, "1, -1", "4, -1")]
    public void ACellCreatedOnAWorldspace_LandsAtItsGrid_InTheBlockAndSubBlockItFallsIn(int x, int y, string block, string subBlock)
    {
        var result = CreateCellAt(x, y);

        Assert.True(result.Applied, result.Message);
        var created = result.NewFormKey.Require();
        Assert.Equal(_edited.ModKey, FormKey.Factory(created).ModKey);
        var cell = JsonNode.Parse(TrackedTree.Body(_plugins.FolderOf(_edited), Edited, created)).Require().AsObject();
        Assert.Equal((x, y), PlacedCell.Grid(cell));
        Assert.False(PlacedCell.IsInterior(cell));
        var file = TrackedTree.DocumentFile(_plugins.FolderOf(_edited), Edited, created).Require();
        Assert.Contains(
            Path.DirectorySeparatorChar + Path.Combine(block, subBlock) + Path.DirectorySeparatorChar, file, StringComparison.Ordinal);
    }

    [Fact]
    public void ACellCreatedWhereThePluginHoldsOne_IsRefusedNamingIt_AndWritesNothing()
    {
        var before = Tree;

        var result = CreateCellAt(5, 6);

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains(_ownCell.ToString(), result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("copy", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, Tree);
    }

    [Fact]
    public void ACellCreatedWhereTheUnsavedTextOfThePluginsCellNoLongerSits_LandsThere_AndWritesNothing()
    {
        var before = Tree;
        var folder = _plugins.FolderOf(_edited);
        var file = Path.Combine(folder, TrackedTree.DocumentFile(folder, Edited, _ownCell.ToString()).Require());
        var moved = JsonNode.Parse(File.ReadAllText(file)).Require().AsObject();
        moved[RecordTypes.CellGridMember] = PlacedCell.GridAt(20, 21);

        var (outcome, changes) = _plugins.CreateHandler.CreateRecord(
            Edited, "cell", [new DocumentChange(file, moved.ToJsonString())], World.ToString(), new GridPosition(5, 6));

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Contains(changes.Documents, document => document.Text.Contains(outcome.NewFormKey.Require(), StringComparison.Ordinal));
        Assert.Equal(before, Tree);
    }

    [Fact]
    public void ACellCreatedWhereTheUnsavedTextOfAMastersCellNoLongerSits_LandsThere()
    {
        var master = _master;
        var folder = _plugins.FolderOf(master);
        var file = Path.Combine(folder, TrackedTree.DocumentFile(folder, Address(master), MasterCell.ToString()).Require());
        var moved = JsonNode.Parse(File.ReadAllText(file)).Require().AsObject();
        moved[RecordTypes.CellGridMember] = PlacedCell.GridAt(20, 21);

        var (outcome, _) = _plugins.CreateHandler.CreateRecord(
            Edited, "cell", [new DocumentChange(file, moved.ToJsonString())], World.ToString(), new GridPosition(3, 3));

        Assert.True(outcome.Applied, outcome.Message);
    }

    [Fact]
    public void ACellCreatedWhereAMasterHoldsOne_IsRefusedNamingIt_PointingAtCopyAsOverride_AndWritesNothing()
    {
        var before = Tree;

        var result = CreateCellAt(3, 3);

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains(MasterCell.ToString(), result.Message, StringComparison.Ordinal);
        Assert.Contains("Copying the record as an override", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, Tree);
    }

    public static TheoryData<FormKey, int, int> OverridesOfAMastersCellSayingNoGridOrAnother => new()
    {
        { PartialFormOverride, 40, 40 },
        { MovedOverride, -40, -40 },
    };

    [Theory]
    [MemberData(nameof(OverridesOfAMastersCellSayingNoGridOrAnother))]
    public void ACellCreatedWhereAMastersCellSits_ThatThePluginOverrides_IsRefusedNamingThePluginsCell_WithNoCopyPointer(
        FormKey overridden, int x, int y)
    {
        var before = Tree;

        var result = CreateCellAt(x, y);

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains($"{_edited.ModKey.FileName} already holds the cell {overridden}", result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Copying the record as an override", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, Tree);
    }

    [Theory]
    [InlineData(1, null)]
    [InlineData(null, 2)]
    public void ACellCreatedOnAWorldspaceWithOneCoordinate_IsRefusedAsAMalformedEnvelope_AndWritesNothing(int? x, int? y)
    {
        var before = Tree;

        var result = CreateCellAt(x, y);

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Equal(before, Tree);
    }

    [Fact]
    public void ACellCreatedOnAWorldspaceWithNoPosition_IsRefusedAsAMalformedEnvelope_AndWritesNothing()
    {
        var before = Tree;

        var result = _plugins.CreateHandler.CreateRecordSync(Edited, "cell", World.ToString());

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Equal(before, Tree);
    }

    [Fact]
    public void ARecordOtherThanACellCreatedOnAWorldspace_IsRefusedAsOneItCannotHold()
    {
        var result = _plugins.CreateHandler.CreateRecordSync(Edited, "npc_", World.ToString());

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Contains(World.ToString(), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordOtherThanACellCreatedOnAWorldspaceWithAGridPosition_IsRefusedAsAMalformedEnvelope()
    {
        var result = _plugins.CreateHandler.CreateRecordSync(Edited, "refr", World.ToString(), new GridPosition(1, 1));

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
    }

    [Fact]
    public void ACellCreatedOnAWorldspaceThePluginDoesNotHold_IsRefusedNamingIt()
    {
        var gone = new FormKey(_edited.ModKey, 0xFFF).ToString();

        var result = _plugins.CreateHandler.CreateRecordSync(Edited, "cell", gone, new GridPosition(1, 1));

        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ACellCreatedOnADeletedWorldspace_IsRefusedAsOneItCannotHold_AndWritesNothing()
    {
        var before = Tree;

        var result = _plugins.CreateHandler.CreateRecordSync(Edited, "cell", _deletedWorld.ToString(), new GridPosition(1, 1));

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
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

    [Fact]
    public void ACellCreatedOnAWorldspace_MovesTheNextObjectIdPastItsFormKey()
    {
        var result = CreateCellAt(7, 7);

        Assert.Equal("000802:Override.esp", result.NewFormKey);
        Assert.Equal(0x803u, TrackedTree.NextObjectId(_plugins.FolderOf(_edited), Edited));
    }
}
