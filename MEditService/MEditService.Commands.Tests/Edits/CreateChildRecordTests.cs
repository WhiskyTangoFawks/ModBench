using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreateChildRecordTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ATopicCreatedOnAQuest_LandsLastInItsTopics_AndItsSiblingsKeepTheirOrder()
    {
        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "dial", _fixture.Quest.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            [_fixture.DialogTopic.ToString(), _fixture.DialogTopic2.ToString(), _fixture.DialogTopic3.ToString(), result.NewFormKey.Require()],
            SlotOf(_fixture.Quest, "DialogTopics"));
    }

    public static TheoryData<string, string, string> OneChildOfEachOtherSlot => new()
    {
        { "dlbr", nameof(ContainerModFixture.Quest), "DialogBranches" },
        { "scen", nameof(ContainerModFixture.Quest), "Scenes" },
        { "info", nameof(ContainerModFixture.DialogTopic), "Responses" },
        { "navm", nameof(ContainerModFixture.EmbedCell), "NavigationMeshes" },
    };

    [Theory]
    [MemberData(nameof(OneChildOfEachOtherSlot))]
    public void AChildCreatedOnItsContainer_LandsLastInItsSlot(string recordType, string container, string slot)
    {
        var containerKey = KeyOf(container);
        var siblings = SlotOf(containerKey, slot);

        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, recordType, containerKey.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Equal([.. siblings, result.NewFormKey.Require()], SlotOf(containerKey, slot));
    }

    public static TheoryData<string, string> ChildrenTheContainerCannotHold => new()
    {
        { "npc_", nameof(ContainerModFixture.Quest) },
        { "land", nameof(ContainerModFixture.Cell) },
        { "land", nameof(ContainerModFixture.EmbedCell) },
    };

    [Theory]
    [MemberData(nameof(ChildrenTheContainerCannotHold))]
    public void AChildItsContainerCannotHold_IsRefused_AndTheTreeIsAsItWas(string recordType, string container)
    {
        var containerKey = KeyOf(container).ToString();
        var before = TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, recordType, containerKey);

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Contains(containerKey, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin));
    }

    [Fact]
    public void ALandscapeCreatedOnAnExteriorCell_LandsAsItsLandscape()
    {
        using var mod = ExteriorCell(out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var landscape = JsonNode.Parse(mod.Body(cell)).Require()["Landscape"].Require();
        Assert.Equal(result.NewFormKey, landscape["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void ANavmeshCreatedOnAnExteriorCell_LandsInItsNavmeshes()
    {
        using var mod = ExteriorCell(out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "navm", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var navmeshes = JsonNode.Parse(mod.Body(cell)).Require()["NavigationMeshes"].Require().AsArray();
        Assert.Equal(result.NewFormKey, Assert.Single(navmeshes).Require()["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void ALandscapeCreatedOnACellHoldingOne_IsRefusedNamingIt_AndTheTreeIsAsItWas()
    {
        using var mod = ExteriorCell(out var cell);
        var held = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString()).NewFormKey.Require();
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString());

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
        Assert.Contains(held, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void AChildCreatedOnADeletedContainer_IsRefused_AndTheTreeIsAsItWas()
    {
        var questKey = FormKey.Null;
        using var mod = SourceModFixture.Tracked("Deleted.esp", "DeletedMod", plugin =>
        {
            var quest = plugin.Quests.AddNew("DeletedQuest");
            quest.MajorRecordFlagsRaw = DeletedFlag.Bit;
            questKey = quest.FormKey;
        });
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "dial", questKey.ToString());

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void ALandscapeCreatedOnADeletedExteriorCellHoldingOne_IsRefusedAsOneItCannotHold()
    {
        using var mod = ExteriorCell(out var cell, (plugin, cell) =>
        {
            cell.Landscape = new Landscape(plugin);
            cell.MajorRecordFlagsRaw = DeletedFlag.Bit;
        });

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "land", cell.ToString());

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
    }

    [Fact]
    public void AChildCreatedOnACellTheTreeHoldsOutsideEveryBlock_IsRefusedAsUnreadable_AndTheTreeIsAsItWas()
    {
        var cell = new RecordIdentity(_fixture.Cell.ToString(), "cell", ContainerModPlugin.CellEditorId);
        var directory = TreeTampering.DirectoryOf(_fixture.ModFolder, _fixture.Plugin, cell);
        var group = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(directory))).Require();
        Directory.Move(directory, Path.Combine(group, Path.GetFileName(directory)));
        var before = TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin);

        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "navm", cell.FormKey);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(_fixture.ModFolder, _fixture.Plugin));
    }

    public static TheoryData<bool, CellPlace> EachCellShape => new()
    {
        { false, CellPlace.Interior },
        { true, CellPlace.Interior },
        { false, CellPlace.Exterior },
        { true, CellPlace.Exterior },
        { false, CellPlace.PersistentWorldspaceCell },
        { true, CellPlace.PersistentWorldspaceCell },
    };

    [Theory]
    [MemberData(nameof(EachCellShape))]
    public void APlacedRecordCreatedOnACell_LandsInTheGroupItsPersistentFlagNames_PersistentAsItsGroup(bool persistent, CellPlace place)
    {
        using var mod = CellShaped(place, cell => cell.MajorRecordFlagsRaw = persistent ? PersistentFlag.Bit : 0, out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var landed = JsonNode.Parse(mod.Body(cell)).Require();
        var group = persistent ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup;
        var created = Assert.Single(landed[group].Require().AsArray()).Require();
        Assert.Equal(result.NewFormKey, created["FormKey"].Require().GetValue<string>());
        Assert.Null(landed[persistent ? PersistentFlag.TemporaryGroup : PersistentFlag.PersistentGroup]);
        Assert.Equal(persistent, (created[RecordHeaderFlags.Member]?.GetValue<int>() ?? 0) == PersistentFlag.Bit);
    }

    public static TheoryData<string> PlacedRecordTableNames => [.. PlacedRecordTables.Names];

    [Theory]
    [MemberData(nameof(PlacedRecordTableNames))]
    public void EveryPlacedRecordCreatedOnAPersistentCell_LandsInItsPersistentGroup(string recordType)
    {
        using var mod = InteriorCell(out var cell, interior => interior.MajorRecordFlagsRaw = PersistentFlag.Bit);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, recordType, cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.PersistentGroup].Require().AsArray());
        Assert.Equal(result.NewFormKey, created.Require()["FormKey"].Require().GetValue<string>());
    }

    [Theory]
    [InlineData("refr", CellPlace.Exterior)]
    [InlineData("phzd", CellPlace.Exterior)]
    [InlineData("refr", CellPlace.Interior)]
    public void APlacedRecordCreatedOnACellWithAGrid_LandsInItsTemporaryGroup_AtTheCentreOfTheGridCell(string recordType, CellPlace place)
    {
        using var mod = CellShaped(place, cell => cell.Grid = new CellGrid { Point = new P2Int(3, -2) }, out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, recordType, cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.TemporaryGroup].Require().AsArray()).Require();
        Assert.Equal(result.NewFormKey, created["FormKey"].Require().GetValue<string>());
        Assert.Equal("14336, -6144, 0", created["Position"].Require().GetValue<string>());
    }

    [Theory]
    [InlineData(CellPlace.Interior)]
    [InlineData(CellPlace.Exterior)]
    [InlineData(CellPlace.PersistentWorldspaceCell)]
    public void APlacedRecordCreatedOnAPersistentCellWithAGrid_KeepsTheBarePosition_WhereverTheCellSits(CellPlace place)
    {
        using var mod = CellShaped(
            place,
            cell =>
            {
                cell.MajorRecordFlagsRaw = PersistentFlag.Bit;
                cell.Grid = new CellGrid { Point = new P2Int(3, -2) };
            },
            out var cell);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.PersistentGroup].Require().AsArray()).Require();
        Assert.Null(created["Position"]);
    }

    [Fact]
    public void APlacedRecordCreatedOnACellWithNoGrid_KeepsTheBarePosition()
    {
        using var mod = InteriorCell(out var cell, _ => { });

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "refr", cell.ToString());

        Assert.True(result.Applied, result.Message);
        var created = Assert.Single(JsonNode.Parse(mod.Body(cell)).Require()[PersistentFlag.TemporaryGroup].Require().AsArray()).Require();
        Assert.Null(created["Position"]);
    }

    [Fact]
    public void ANavmeshCreatedOnAnInteriorCellCarryingThePersistentFlag_IsRefused_AndTheTreeIsAsItWas()
    {
        using var mod = InteriorCell(out var cell, interior => interior.MajorRecordFlagsRaw = PersistentFlag.Bit);
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "navm", cell.ToString());

        Assert.Equal(RecordEditRefusal.ContainerCannotHoldType, result.Refusal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    private static SourceModFixture CellShaped(CellPlace place, Action<Cell> shape, out FormKey cell) => place switch
    {
        CellPlace.Interior => InteriorCell(out cell, shape),
        CellPlace.Exterior => ExteriorCell(out cell, (_, exterior) => shape(exterior)),
        CellPlace.PersistentWorldspaceCell => WorldspacePersistentCell(out cell, shape),
        _ => throw new ArgumentOutOfRangeException(nameof(place), place, "No fixture builds a cell there."),
    };

    private static SourceModFixture InteriorCell(out FormKey cell, Action<Cell> shape)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.Tracked("Interior.esp", "InteriorMod", plugin =>
        {
            var interior = new Cell(plugin) { EditorID = "InteriorCell", Flags = Cell.Flag.IsInteriorCell };
            shape(interior);
            plugin.Cells.Records.Add(CellBlocks.Interior(interior));
            cellKey = interior.FormKey;
        });
        cell = cellKey;
        return mod;
    }

    private static SourceModFixture WorldspacePersistentCell(out FormKey cell, Action<Cell> shape)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.Tracked("Persistent.esp", "PersistentMod", plugin =>
        {
            var persistentCell = new Cell(plugin) { EditorID = "PersistentCell" };
            shape(persistentCell);
            plugin.Worldspaces.AddNew("World").TopCell = persistentCell;
            cellKey = persistentCell.FormKey;
        });
        cell = cellKey;
        return mod;
    }

    private static SourceModFixture ExteriorCell(out FormKey cell, Action<Fallout4Mod, Cell>? shape = null)
    {
        var cellKey = FormKey.Null;
        var mod = SourceModFixture.Tracked("Exterior.esp", "ExteriorMod", plugin =>
        {
            var exterior = new Cell(plugin) { EditorID = "ExteriorCell", Grid = new CellGrid() };
            shape?.Invoke(plugin, exterior);
            plugin.Worldspaces.AddNew("World").SubCells.Add(CellBlocks.Exterior(exterior));
            cellKey = exterior.FormKey;
        });
        cell = cellKey;
        return mod;
    }

    private FormKey KeyOf(string container) =>
        (FormKey)typeof(ContainerModFixture).GetProperty(container).Require().GetValue(_fixture).Require();

    private string[] SlotOf(FormKey container, string slot) =>
        [.. JsonNode.Parse(_fixture.Document(container.ToString()).Require().Body).Require()[slot].Require().AsArray()
            .Select(child => child.Require()["FormKey"].Require().GetValue<string>())];

    [Fact]
    public void ACreatedChild_MovesTheNextObjectIdPastItsFormKey()
    {
        var result = _fixture.CreateHandler.CreateRecord(_fixture.Plugin, "dial", _fixture.Quest.ToString());

        Assert.Equal(FormKey.Factory(result.NewFormKey.Require()).ID + 1, _fixture.NextObjectId());
    }
}
