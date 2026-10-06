using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PersistentFlagEditTests : IDisposable
{
    private const int Deleted = 0x0020, Persistent = 0x0400, InitiallyDisabled = 0x0800;
    private const float CellWidth = 4096f;

    private readonly SourceModFixture _mod;
    private readonly Dictionary<string, FormKey> _keys = [];

    public PersistentFlagEditTests()
    {
        _mod = SourceModFixture.Tracked("Persistence.esp", "PersistenceMod", plugin =>
        {
            var inside = NewCell(plugin, "Inside", Cell.Flag.IsInteriorCell);
            inside.Temporary.Add(Placed(plugin, "InsideTemp", 0, 1f, 2f));
            inside.Persistent.Add(Placed(plugin, "InsidePersist", Persistent, 1f, 2f));
            var unmarked = NewCell(plugin, "Unmarked", 0);
            unmarked.Temporary.Add(Placed(plugin, "UnmarkedTemp", 0, 1f, 2f));
            var ruin = NewCell(plugin, "Ruin", Cell.Flag.IsInteriorCell);
            ruin.Temporary.Add(Placed(plugin, "RuinDeleted", Deleted, 1f, 2f));
            ruin.Persistent.Add(Placed(plugin, "RuinDeletedPersistent", Deleted | Persistent, 1f, 2f));
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(inside);
            subBlock.Cells.Add(ruin);
            subBlock.Cells.Add(unmarked);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            plugin.Cells.Records.Add(block);

            var world = new Worldspace(plugin) { EditorID = "World" };
            _keys["World"] = world.FormKey;
            plugin.Worldspaces.Add(world);
            var topCell = NewCell(plugin, "WorldPersistentCell", 0);
            topCell.MajorRecordFlagsRaw = Persistent;
            topCell.Temporary.Add(Placed(plugin, "TopTemp", 0, CellWidth, CellWidth));
            topCell.Persistent.Add(Placed(plugin, "TopPersist", Persistent, CellWidth, CellWidth));
            world.TopCell = topCell;

            var outside = NewCell(plugin, "Outside", 0);
            outside.Grid = new CellGrid { Point = new P2Int(1, 1) };
            outside.Temporary.Add(Placed(plugin, "OutsideTemp", 0, 1.5f * CellWidth, 1.5f * CellWidth));
            outside.Temporary.Add(Placed(plugin, "OutsideStale", Persistent, 1.5f * CellWidth, 1.5f * CellWidth));
            var holding = NewCell(plugin, "Holding", 0);
            holding.Grid = new CellGrid { Point = new P2Int(2, -1) };
            holding.Persistent.Add(Placed(plugin, "HoldingWithin", Persistent, 2.5f * CellWidth, -0.5f * CellWidth));
            holding.Persistent.Add(Placed(plugin, "HoldingBeyond", Persistent, 1.5f * CellWidth, 1.5f * CellWidth));
            world.SubCells.Add(CellBlocks.Exterior(outside));
            world.SubCells.Add(CellBlocks.Exterior(holding));
        });
    }

    public void Dispose() => _mod.Dispose();

    private Cell NewCell(Fallout4Mod plugin, string editorId, Cell.Flag flags)
    {
        var cell = new Cell(plugin) { EditorID = editorId, Flags = flags };
        _keys[editorId] = cell.FormKey;
        return cell;
    }

    private PlacedObject Placed(Fallout4Mod plugin, string editorId, int flags, float x, float y)
    {
        var placed = new PlacedObject(plugin) { EditorID = editorId, MajorRecordFlagsRaw = flags, Scale = 2f, Position = new P3Float(x, y, 0f) };
        _keys[editorId] = placed.FormKey;
        return placed;
    }

    private RecordEditResult SetFlags(string placed, int raw) =>
        _mod.EditHandler.Edit(
            _mod.Plugin, _keys[placed].ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

    private JsonObject Document(string editorId) =>
        JsonNode.Parse(TrackedTree.Document(_mod.ModFolder, _mod.Plugin, _keys[editorId].ToString()).Require().Body).Require().AsObject();

    private List<string> Group(string cell, string group) =>
        [.. (Document(cell)[group] as JsonArray ?? []).Select(placed => placed.Require()["EditorID"].Require().GetValue<string>())];

    private void AssertOnlyFlagsChanged(JsonObject before, string placed, int flags)
    {
        var after = Document(placed);
        Assert.Equal(flags, after["MajorRecordFlagsRaw"]?.GetValue<int>() ?? 0);
        foreach (var flagMembers in new[] { before, after })
        {
            flagMembers.Remove("MajorRecordFlagsRaw");
            flagMembers.Remove("Fallout4MajorRecordFlags");
        }
        Assert.True(JsonNode.DeepEquals(before, after), after.ToJsonString());
    }

    private void AssertRefusedUnchanged(RecordEditResult result, RecordEditRefusal refusal, string cell, JsonObject before)
    {
        Assert.Equal(refusal, result.Refusal);
        Assert.True(JsonNode.DeepEquals(before, Document(cell)), Document(cell).ToJsonString());
    }

    [Fact]
    public void SettingPersistent_OnAPlacedRecordInAnInteriorCell_MovesItIntoTheCellsPersistentGroup()
    {
        var before = Document("InsideTemp");

        var result = SetFlags("InsideTemp", Persistent);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["InsidePersist", "InsideTemp"], Group("Inside", "Persistent"));
        Assert.Empty(Group("Inside", "Temporary"));
        AssertOnlyFlagsChanged(before, "InsideTemp", Persistent);
    }

    [Fact]
    public void ClearingPersistent_OnAPlacedRecordInAnInteriorCell_MovesItIntoTheCellsTemporaryGroup()
    {
        var before = Document("InsidePersist");

        var result = SetFlags("InsidePersist", 0);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["InsideTemp", "InsidePersist"], Group("Inside", "Temporary"));
        Assert.Empty(Group("Inside", "Persistent"));
        AssertOnlyFlagsChanged(before, "InsidePersist", 0);
    }

    [Fact]
    public void SettingPersistent_OnAPlacedRecordInAWorldspacesPersistentCell_MovesItIntoThatCellsPersistentGroup()
    {
        var before = Document("TopTemp");

        var result = SetFlags("TopTemp", Persistent);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["TopPersist", "TopTemp"], Group("WorldPersistentCell", "Persistent"));
        Assert.Empty(Group("WorldPersistentCell", "Temporary"));
        AssertOnlyFlagsChanged(before, "TopTemp", Persistent);
    }

    [Fact]
    public void ClearingPersistent_OnAPlacedRecordInAWorldspacesPersistentCell_MovesItIntoTheCellAtItsPosition()
    {
        var before = Document("TopPersist");

        var result = SetFlags("TopPersist", 0);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["OutsideTemp", "OutsideStale", "TopPersist"], Group("Outside", "Temporary"));
        Assert.Empty(Group("WorldPersistentCell", "Persistent"));
        AssertOnlyFlagsChanged(before, "TopPersist", 0);
    }

    [Fact]
    public void SettingPersistent_OnAPlacedRecordInAnExteriorCell_MovesItIntoItsWorldspacesPersistentCell()
    {
        var before = Document("OutsideTemp");

        var result = SetFlags("OutsideTemp", Persistent);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["TopPersist", "OutsideTemp"], Group("WorldPersistentCell", "Persistent"));
        Assert.Equal(["OutsideStale"], Group("Outside", "Temporary"));
        AssertOnlyFlagsChanged(before, "OutsideTemp", Persistent);
    }

    [Fact]
    public void AMoveIntoAnotherCellWhoseDocumentCannotBeWritten_LeavesTheSourceTreeUnchanged()
    {
        TreeTampering.BlockWrite(_mod.ModFolder, _mod.Plugin, new RecordIdentity(_keys["World"].ToString(), "wrld", "World"));
        var before = TrackedTree.Records(_mod.ModFolder, _mod.Plugin);

        var result = SetFlags("OutsideTemp", Persistent);

        Assert.Equal(RecordEditRefusal.SourceWriteFailed, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(_mod.ModFolder, _mod.Plugin));
        Assert.Contains("back as it was — nothing to review or revert", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ClearingPersistent_OnAPlacedRecordInsideItsExteriorCellsGrid_MovesItIntoAGroupTheCellLacked()
    {
        var before = Document("HoldingWithin");
        Assert.Empty(Group("Holding", "Temporary"));

        var result = SetFlags("HoldingWithin", 0);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["HoldingWithin"], Group("Holding", "Temporary"));
        Assert.Equal(["HoldingBeyond"], Group("Holding", "Persistent"));
        AssertOnlyFlagsChanged(before, "HoldingWithin", 0);
    }

    [Fact]
    public void ClearingPersistent_OnAPlacedRecordOutsideItsExteriorCellsGrid_MovesItIntoTheCellAtItsPosition()
    {
        var result = SetFlags("HoldingBeyond", 0);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["OutsideTemp", "OutsideStale", "HoldingBeyond"], Group("Outside", "Temporary"));
        Assert.Equal(["HoldingWithin"], Group("Holding", "Persistent"));
    }

    [Fact]
    public void SettingPersistent_InACellNoCopyOfWhichSaysWhereItSits_IsRefused()
    {
        var before = Document("Unmarked");

        AssertRefusedUnchanged(SetFlags("UnmarkedTemp", Persistent), RecordEditRefusal.PersistentMoveDestinationUnknown, "Unmarked", before);
    }

    [Fact]
    public void SettingPersistent_OnADeletedPlacedRecord_IsRefused_NamingDeleted()
    {
        var before = Document("Ruin");

        var result = SetFlags("RuinDeleted", Deleted | Persistent);

        AssertRefusedUnchanged(result, RecordEditRefusal.PersistentOnDeletedRecord, "Ruin", before);
        Assert.Contains("Deleted", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ClearingPersistent_OnADeletedPlacedRecord_IsRefused()
    {
        var before = Document("Ruin");

        AssertRefusedUnchanged(SetFlags("RuinDeletedPersistent", Deleted), RecordEditRefusal.PersistentOnDeletedRecord, "Ruin", before);
    }

    [Fact]
    public void SettingPersistentAndDeleted_InOneWrite_IsRefused()
    {
        var before = Document("Inside");

        AssertRefusedUnchanged(SetFlags("InsideTemp", Deleted | Persistent), RecordEditRefusal.PersistentOnDeletedRecord, "Inside", before);
    }

    [Fact]
    public void AnotherFlag_OnAPlacedRecordAlreadyPersistentInATemporaryGroup_LeavesItWhereItIs()
    {
        var result = SetFlags("OutsideStale", Persistent | InitiallyDisabled);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["OutsideTemp", "OutsideStale"], Group("Outside", "Temporary"));
        Assert.Equal(Persistent | InitiallyDisabled, Document("OutsideStale")["MajorRecordFlagsRaw"].Require().GetValue<int>());
    }
}
