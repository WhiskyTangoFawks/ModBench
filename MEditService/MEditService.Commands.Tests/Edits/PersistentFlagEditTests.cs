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
        _mod = SourceModFixture.CompiledPlugin("Persistence.esp", "PersistenceMod", plugin =>
        {
            var inside = NewCell(plugin, "Inside", Cell.Flag.IsInteriorCell);
            inside.Temporary.Add(Placed(plugin, "InsideTemp", 0, 1f, 2f));
            inside.Persistent.Add(Placed(plugin, "InsidePersist", Persistent, 1f, 2f));
            var unmarked = NewCell(plugin, "Unmarked", 0);
            unmarked.Temporary.Add(Placed(plugin, "UnmarkedTemp", 0, 1f, 2f));
            var ruin = NewCell(plugin, "Ruin", Cell.Flag.IsInteriorCell);
            ruin.Temporary.Add(Placed(plugin, "RuinDeleted", Deleted, 1f, 2f));
            plugin.AddInteriorCells(inside, ruin, unmarked);

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
            world.SubCells.Add(CellBlocks.Exterior(holding));
            world.SubCells.Add(CellBlocks.Exterior(outside));
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
        JsonNode.Parse(SourceModTree.Document(_mod.ModFolder, _mod.Plugin, _keys[editorId].ToString()).Require().Body).Require().AsObject();

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

    [Theory]
    [InlineData("InsideTemp", Persistent, "Inside", "Persistent", new[] { "InsideTemp", "InsidePersist" }, "Inside", "Temporary", new string[0])]
    [InlineData("TopTemp", Persistent, "WorldPersistentCell", "Persistent", new[] { "TopTemp", "TopPersist" }, "WorldPersistentCell", "Temporary", new string[0])]
    [InlineData("HoldingWithin", 0, "Holding", "Temporary", new[] { "HoldingWithin" }, "Holding", "Persistent", new[] { "HoldingBeyond" })]
    [InlineData("OutsideTemp", Persistent, "WorldPersistentCell", "Persistent", new[] { "TopPersist", "OutsideTemp" }, "Outside", "Temporary", new[] { "OutsideStale" })]
    [InlineData("TopPersist", 0, "Outside", "Temporary", new[] { "TopPersist", "OutsideTemp", "OutsideStale" }, "WorldPersistentCell", "Persistent", new string[0])]
    public void ChangingPersistent_MovesThePlacedRecordIntoTheGroupItNames_OfTheCellXEditWouldPutItIn(
        string placed, int written, string intoCell, string intoGroup, string[] into, string fromCell, string fromGroup, string[] left)
    {
        var before = Document(placed);

        var result = SetFlags(placed, written);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(into, Group(intoCell, intoGroup));
        Assert.Equal(left, Group(fromCell, fromGroup));
        AssertOnlyFlagsChanged(before, placed, written);
    }

    [Fact]
    public void ClearingPersistent_IntoTheCellAtItsPosition_WhoseDocumentIsNoJson_IsRefusedAsRecordParseFailed_AndAnswersNoChanges()
    {
        File.WriteAllText(
            TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, new RecordIdentity(_keys["Outside"].ToString(), "cell", "Outside")),
            "this is no JSON");
        var before = Document("Holding");

        var result = SetFlags("HoldingBeyond", 0);

        AssertRefusedUnchanged(result, RecordEditRefusal.RecordParseFailed, "Holding", before);
        Assert.Contains($"the cell {_keys["HoldingBeyond"]} moves into cannot be read", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SettingPersistent_InACellNoCopyOfWhichSaysWhereItSits_IsRefused()
    {
        var before = Document("Unmarked");

        AssertRefusedUnchanged(SetFlags("UnmarkedTemp", Persistent), RecordEditRefusal.PersistentMoveDestinationUnknown, "Unmarked", before);
    }

    [Theory]
    [InlineData("RuinDeleted", Deleted | Persistent, "Ruin")]
    [InlineData("InsideTemp", Deleted | Persistent, "Inside")]
    public void ChangingPersistent_OnAPlacedRecordDeletedBeforeOrByTheWrite_IsRefused_NamingDeleted(string placed, int written, string cell)
    {
        var before = Document(cell);

        var result = SetFlags(placed, written);

        AssertRefusedUnchanged(result, RecordEditRefusal.PersistentOnDeletedRecord, cell, before);
        Assert.Contains("Deleted", result.Message, StringComparison.Ordinal);
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
