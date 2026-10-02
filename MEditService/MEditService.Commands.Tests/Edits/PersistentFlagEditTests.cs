using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PersistentFlagEditTests : IDisposable
{
    private const int Persistent = 0x0400, InitiallyDisabled = 0x0800;

    private readonly SourceModFixture _mod;
    private readonly FormKey _interior, _interiorTemporary, _interiorPersistent;
    private readonly FormKey _topCell, _topCellTemporary, _topCellPersistent;
    private readonly FormKey _exterior, _exteriorTemporary, _exteriorPersistentInTemporary;

    public PersistentFlagEditTests()
    {
        var keys = new FormKey[9];
        _mod = SourceModFixture.Tracked("Persistence.esp", "PersistenceMod", plugin =>
        {
            var cell = new Cell(plugin) { EditorID = "Inside" };
            var temporary = new PlacedObject(plugin) { EditorID = "InsideTemp", Scale = 2f, Position = new P3Float(1f, 2f, 3f) };
            var persistent = new PlacedObject(plugin) { EditorID = "InsidePersist", MajorRecordFlagsRaw = Persistent };
            cell.Temporary.Add(temporary);
            cell.Persistent.Add(persistent);
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            plugin.Cells.Records.Add(block);
            (keys[0], keys[1], keys[2]) = (cell.FormKey, temporary.FormKey, persistent.FormKey);

            var world = new Worldspace(plugin) { EditorID = "World" };
            plugin.Worldspaces.Add(world);
            var topCell = new Cell(plugin) { EditorID = "WorldPersistentCell", MajorRecordFlagsRaw = Persistent };
            var topTemporary = new PlacedObject(plugin) { EditorID = "TopTemp", Position = new P3Float(5000f, 5000f, 0f) };
            var topPersistent = new PlacedObject(plugin) { EditorID = "TopPersist", MajorRecordFlagsRaw = Persistent, Position = new P3Float(5000f, 5000f, 0f) };
            topCell.Temporary.Add(topTemporary);
            topCell.Persistent.Add(topPersistent);
            world.TopCell = topCell;
            var exterior = new Cell(plugin) { EditorID = "Outside", Grid = new CellGrid { Point = new P2Int(1, 1) } };
            var exteriorTemporary = new PlacedObject(plugin) { EditorID = "OutsideTemp", Position = new P3Float(5000f, 5000f, 0f) };
            var persistentInTemporary = new PlacedObject(plugin) { EditorID = "OutsideStale", MajorRecordFlagsRaw = Persistent, Position = new P3Float(5000f, 5000f, 0f) };
            exterior.Temporary.Add(exteriorTemporary);
            exterior.Temporary.Add(persistentInTemporary);
            var worldSubBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
            worldSubBlock.Items.Add(exterior);
            var worldBlock = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
            worldBlock.Items.Add(worldSubBlock);
            world.SubCells.Add(worldBlock);
            (keys[3], keys[4], keys[5]) = (topCell.FormKey, topTemporary.FormKey, topPersistent.FormKey);
            (keys[6], keys[7], keys[8]) = (exterior.FormKey, exteriorTemporary.FormKey, persistentInTemporary.FormKey);
        });
        (_interior, _interiorTemporary, _interiorPersistent) = (keys[0], keys[1], keys[2]);
        (_topCell, _topCellTemporary, _topCellPersistent) = (keys[3], keys[4], keys[5]);
        (_exterior, _exteriorTemporary, _exteriorPersistentInTemporary) = (keys[6], keys[7], keys[8]);
    }

    public void Dispose() => _mod.Dispose();

    private RecordEditResult SetFlags(FormKey placed, int raw) =>
        _mod.EditHandler.Edit(
            _mod.Plugin, placed.ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

    private JsonObject Document(FormKey formKey) =>
        JsonNode.Parse(TrackedTree.Document(_mod.ModFolder, _mod.Plugin, formKey.ToString()).Require().Body).Require().AsObject();

    private List<string> Group(FormKey cell, string group) =>
        [.. (Document(cell)[group] as JsonArray ?? []).Select(placed => placed.Require()["FormKey"].Require().GetValue<string>())];

    // The record arrives with every field it had, and only its flags changed.
    private void AssertMovedWhole(JsonObject before, FormKey placed, int flags)
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

    [Fact]
    public void SettingPersistent_OnAPlacedRecordInAnInteriorCell_MovesItIntoTheCellsPersistentGroup()
    {
        var before = Document(_interiorTemporary);

        var result = SetFlags(_interiorTemporary, Persistent);

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_interiorPersistent.ToString(), _interiorTemporary.ToString()], Group(_interior, "Persistent"));
        Assert.Empty(Group(_interior, "Temporary"));
        AssertMovedWhole(before, _interiorTemporary, Persistent);
    }

    [Fact]
    public void ClearingPersistent_OnAPlacedRecordInAnInteriorCell_MovesItIntoTheCellsTemporaryGroup()
    {
        var before = Document(_interiorPersistent);

        var result = SetFlags(_interiorPersistent, 0);

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_interiorTemporary.ToString(), _interiorPersistent.ToString()], Group(_interior, "Temporary"));
        Assert.Empty(Group(_interior, "Persistent"));
        AssertMovedWhole(before, _interiorPersistent, 0);
    }

    [Fact]
    public void SettingPersistent_OnAPlacedRecordInAWorldspacesPersistentCell_MovesItIntoThatCellsPersistentGroup()
    {
        var before = Document(_topCellTemporary);

        var result = SetFlags(_topCellTemporary, Persistent);

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_topCellPersistent.ToString(), _topCellTemporary.ToString()], Group(_topCell, "Persistent"));
        Assert.Empty(Group(_topCell, "Temporary"));
        AssertMovedWhole(before, _topCellTemporary, Persistent);
    }

    [Fact]
    public void SettingPersistent_OnAPlacedRecordInAnExteriorCell_IsRefused()
    {
        var before = Document(_exterior);

        var result = SetFlags(_exteriorTemporary, Persistent);

        Assert.Equal(RecordEditRefusal.PersistentMoveIntoAnotherCell, result.Refusal);
        Assert.True(JsonNode.DeepEquals(before, Document(_exterior)), Document(_exterior).ToJsonString());
    }

    [Fact]
    public void ClearingPersistent_OnAPlacedRecordInAWorldspacesPersistentCell_IsRefused()
    {
        var before = Document(_topCell);

        var result = SetFlags(_topCellPersistent, 0);

        Assert.Equal(RecordEditRefusal.PersistentMoveIntoAnotherCell, result.Refusal);
        Assert.True(JsonNode.DeepEquals(before, Document(_topCell)), Document(_topCell).ToJsonString());
    }

    [Fact]
    public void AnotherFlag_OnAPlacedRecordAlreadyPersistentInATemporaryGroup_LeavesItWhereItIs()
    {
        var result = SetFlags(_exteriorPersistentInTemporary, Persistent | InitiallyDisabled);

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_exteriorTemporary.ToString(), _exteriorPersistentInTemporary.ToString()], Group(_exterior, "Temporary"));
        Assert.Equal(Persistent | InitiallyDisabled, Document(_exteriorPersistentInTemporary)["MajorRecordFlagsRaw"].Require().GetValue<int>());
    }
}
